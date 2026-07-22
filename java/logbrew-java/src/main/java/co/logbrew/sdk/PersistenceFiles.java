package co.logbrew.sdk;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Owner-only, no-follow filesystem boundary for encrypted persistence. */
final class PersistenceFiles implements AutoCloseable {
    static final String LOCK_NAME = ".owner.lock";
    static final String KEY_CHECK_NAME = ".key-check.lbe";
    static final String CHECKPOINT_NAME = ".checkpoint.lbe";
    static final String HIGH_WATER_NAME = ".admitted.lbe";
    static final String INTENT_NAME = ".intent.lbe";
    static final String PURGE_INTENT_NAME = ".purge-intent.lbe";

    private static final Pattern RECORD_NAME = Pattern.compile("([0-9]{20})\\.lbe");
    private static final Pattern TEMP_NAME = Pattern.compile(
        "\\.(?:pending|intent-pending|key-pending|purge-pending)-[0-9a-f]{32}\\.tmp"
    );
    private static final Set<PosixFilePermission> DIRECTORY_PERMISSIONS =
        Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE,
            PosixFilePermission.OWNER_EXECUTE
        )));
    private static final Set<PosixFilePermission> FILE_PERMISSIONS =
        Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE
        )));

    private final Path directory;
    private final Object directoryKey;
    private final FileChannel lockChannel;
    private final FileLock lock;
    private final Object lockKey;
    private final WriteOperation writeOperation;
    private final ReadOperation readOperation;
    private boolean closed;

    static PersistenceFiles open(Path requestedDirectory) {
        return open(requestedDirectory, FileChannel::write, FileChannel::read);
    }

    static PersistenceFiles open(Path requestedDirectory, WriteOperation writeOperation) {
        return open(requestedDirectory, writeOperation, FileChannel::read);
    }

    static PersistenceFiles open(
        Path requestedDirectory,
        WriteOperation writeOperation,
        ReadOperation readOperation
    ) {
        Path directory = requestedDirectory.toAbsolutePath().normalize();
        FileChannel channel = null;
        FileLock lock = null;
        try {
            prepareDirectory(directory);
            Object directoryKey = fileKey(readAttributes(directory), true);
            Path lockPath = directory.resolve(LOCK_NAME);
            createAtomicOwnerFileIfAbsent(lockPath);
            verifyRegularFile(lockPath);
            Object lockKeyBeforeOpen = fileKey(readAttributes(lockPath), false);
            channel = FileChannel.open(
                lockPath,
                StandardOpenOption.WRITE,
                LinkOption.NOFOLLOW_LINKS
            );
            Object lockKeyAfterOpen = fileKey(readAttributes(lockPath), false);
            if (!lockKeyBeforeOpen.equals(lockKeyAfterOpen)) {
                throw new SdkException("persistence_replaced", "persistence lock ownership changed");
            }
            try {
                lock = channel.tryLock();
            } catch (OverlappingFileLockException error) {
                throw new SdkException(
                    "persistence_in_use",
                    "persistence store is already owned by this process"
                );
            }
            if (lock == null) {
                throw new SdkException(
                    "persistence_in_use",
                    "persistence store is already owned by another process"
                );
            }
            return new PersistenceFiles(
                directory,
                directoryKey,
                channel,
                lock,
                lockKeyAfterOpen,
                writeOperation,
                readOperation
            );
        } catch (SdkException error) {
            releaseQuietly(lock, channel);
            throw error;
        } catch (IOException error) {
            releaseQuietly(lock, channel);
            throw new SdkException(
                "persistence_error",
                "persistence store could not be opened safely"
            );
        }
    }

    private PersistenceFiles(
        Path directory,
        Object directoryKey,
        FileChannel lockChannel,
        FileLock lock,
        Object lockKey,
        WriteOperation writeOperation,
        ReadOperation readOperation
    ) {
        this.directory = directory;
        this.directoryKey = directoryKey;
        this.lockChannel = lockChannel;
        this.lock = lock;
        this.lockKey = lockKey;
        this.writeOperation = writeOperation;
        this.readOperation = readOperation;
    }

    synchronized Layout layout() {
        verifyBoundary();
        List<Path> records = new ArrayList<>();
        List<Path> temporary = new ArrayList<>();
        List<Path> purgeable = new ArrayList<>();
        Path checkpoint = null;
        Path highWater = null;
        Path intent = null;
        Path purgeIntent = null;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory)) {
            for (Path path : stream) {
                String name = path.getFileName().toString();
                if (LOCK_NAME.equals(name) || KEY_CHECK_NAME.equals(name)) {
                    verifyRegularFile(path);
                } else if (CHECKPOINT_NAME.equals(name)) {
                    verifyRegularFile(path);
                    checkpoint = path;
                    purgeable.add(path);
                } else if (HIGH_WATER_NAME.equals(name)) {
                    verifyRegularFile(path);
                    highWater = path;
                    purgeable.add(path);
                } else if (INTENT_NAME.equals(name)) {
                    verifyRegularFile(path);
                    intent = path;
                    purgeable.add(path);
                } else if (PURGE_INTENT_NAME.equals(name)) {
                    verifyRegularFile(path);
                    purgeIntent = path;
                } else if (RECORD_NAME.matcher(name).matches()) {
                    verifyRegularFile(path);
                    records.add(path);
                    purgeable.add(path);
                } else if (TEMP_NAME.matcher(name).matches()) {
                    verifyRegularFile(path);
                    temporary.add(path);
                    purgeable.add(path);
                } else {
                    throw new SdkException(
                        "persistence_layout_error",
                        "persistence directory contains an unknown entry"
                    );
                }
            }
        } catch (IOException error) {
            throw new SdkException(
                "persistence_error",
                "persistence directory could not be inspected"
            );
        }
        records.sort(Comparator.comparingLong(PersistenceFiles::recordSequence));
        return new Layout(records, temporary, purgeable, checkpoint, highWater, intent, purgeIntent);
    }

    synchronized Path path(String name) {
        verifyName(name);
        return directory.resolve(name);
    }

    synchronized Path recordPath(long sequence) {
        if (sequence <= 0L) {
            PersistenceCrypto.integrityFailure();
        }
        return path(String.format(Locale.ROOT, "%020d.lbe", Long.valueOf(sequence)));
    }

    synchronized OwnedFile createTemporary(String role) throws IOException {
        String name = "." + role + "-" + UUID.randomUUID().toString().replace("-", "") + ".tmp";
        if (!TEMP_NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("unsupported persistence temporary role");
        }
        Path target = path(name);
        return createAtomicOwnerFile(target);
    }

    synchronized FileIdentity writeAndForce(OwnedFile file, byte[] bytes) throws IOException {
        verifyBoundary();
        verifyOwnedPath(file);
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) {
            if (writeOperation.write(file.channel, buffer) <= 0) {
                throw new IOException("persistence write made no progress");
            }
        }
        file.channel.force(true);
        verifyOwnedPath(file);
        return verifyExact(file.path, bytes.length, PersistenceCrypto.digest(bytes), file.fileKey);
    }

    synchronized FileData read(Path path, long maxBytes) {
        verifyBoundary();
        if (maxBytes <= 0L || maxBytes > Integer.MAX_VALUE) {
            throw new SdkException("persistence_bounds_exceeded", "persistence read bound is invalid");
        }
        verifyRegularFile(path);
        BasicFileAttributes before = readAttributes(path);
        Object beforeKey = fileKey(before, false);
        long size = before.size();
        if (size <= 0L || size > maxBytes) {
            PersistenceCrypto.integrityFailure();
        }

        byte[] bytes = new byte[(int) size];
        try (FileChannel channel = FileChannel.open(
            path,
            StandardOpenOption.READ,
            LinkOption.NOFOLLOW_LINKS
        )) {
            if (channel.size() != size) {
                PersistenceCrypto.integrityFailure();
            }
            ByteBuffer target = ByteBuffer.wrap(bytes);
            while (target.hasRemaining()) {
                int read = readOperation.read(channel, target);
                if (read < 0) {
                    PersistenceCrypto.integrityFailure();
                }
                if (read == 0) {
                    throw new SdkException(
                        "persistence_integrity_error",
                        "persistence read made no progress"
                    );
                }
            }
            if (readOperation.read(channel, ByteBuffer.allocate(1)) != -1) {
                PersistenceCrypto.integrityFailure();
            }
        } catch (IOException error) {
            Arrays.fill(bytes, (byte) 0);
            throw new SdkException("persistence_error", "persistence file could not be read safely");
        }

        verifyRegularFile(path);
        BasicFileAttributes after = readAttributes(path);
        Object afterKey = fileKey(after, false);
        if (!beforeKey.equals(afterKey) || after.size() != size) {
            Arrays.fill(bytes, (byte) 0);
            PersistenceCrypto.integrityFailure();
        }
        return new FileData(bytes, new FileIdentity(
            beforeKey,
            size,
            PersistenceCrypto.digest(bytes)
        ));
    }

    synchronized FileIdentity verifyExact(
        Path path,
        long expectedSize,
        byte[] expectedDigest,
        Object expectedFileKey
    ) {
        FileData data = read(path, expectedSize);
        try {
            if (data.identity.size != expectedSize
                || !java.security.MessageDigest.isEqual(data.identity.digest, expectedDigest)
                || (expectedFileKey != null && !expectedFileKey.equals(data.identity.fileKey))) {
                PersistenceCrypto.integrityFailure();
            }
            return data.identity;
        } finally {
            Arrays.fill(data.bytes, (byte) 0);
        }
    }

    synchronized void move(OwnedFile source, Path target, boolean replace) throws IOException {
        verifyBoundary();
        verifyOwnedPath(source);
        source.close();
        verifyOwnedPath(source);
        moveExisting(source.path, target, replace);
    }

    synchronized void moveExisting(Path source, Path target, boolean replace) throws IOException {
        verifyBoundary();
        verifyRegularFile(source);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            verifyRegularFile(target);
        }
        try {
            if (replace) {
                Files.move(
                    source,
                    target,
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                );
            } else {
                Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
            }
        } catch (AtomicMoveNotSupportedException error) {
            throw new SdkException(
                "persistence_unsupported",
                "atomic persistence replacement is unavailable"
            );
        }
    }

    synchronized void delete(Path path) throws IOException {
        verifyBoundary();
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            verifyRegularFile(path);
            Files.delete(path);
        }
    }

    synchronized void syncDirectory() throws IOException {
        verifyBoundary();
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            channel.force(true);
        }
    }

    synchronized boolean exists(Path path) {
        verifyBoundary();
        return Files.exists(path, LinkOption.NOFOLLOW_LINKS);
    }

    synchronized void verifyBoundary() {
        ensureOpen();
        BasicFileAttributes directoryAttributes = readAttributes(directory);
        if (!directoryAttributes.isDirectory()
            || !directoryKey.equals(fileKey(directoryAttributes, true))) {
            throw new SdkException(
                "persistence_replaced",
                "persistence directory ownership changed"
            );
        }
        verifyOwnerOnly(directory, true);
        if (!lock.isValid()) {
            throw new SdkException("persistence_in_use", "persistence ownership lock is no longer valid");
        }
        Path lockPath = directory.resolve(LOCK_NAME);
        verifyRegularFile(lockPath);
        if (!lockKey.equals(fileKey(readAttributes(lockPath), false))) {
            throw new SdkException("persistence_replaced", "persistence lock ownership changed");
        }
    }

    @Override
    public synchronized void close() {
        if (closed) {
            return;
        }
        closed = true;
        releaseQuietly(lock, lockChannel);
    }

    static long recordSequence(Path path) {
        Matcher matcher = RECORD_NAME.matcher(path.getFileName().toString());
        if (!matcher.matches()) {
            PersistenceCrypto.integrityFailure();
        }
        try {
            long value = Long.parseLong(matcher.group(1));
            if (value <= 0L) {
                PersistenceCrypto.integrityFailure();
            }
            return value;
        } catch (NumberFormatException error) {
            PersistenceCrypto.integrityFailure();
            throw new AssertionError("unreachable");
        }
    }

    private static void prepareDirectory(Path directory) throws IOException {
        Path current = directory.getRoot();
        for (Path part : directory) {
            current = current == null ? part : current.resolve(part);
            if (Files.exists(current, LinkOption.NOFOLLOW_LINKS)) {
                BasicFileAttributes attributes = readAttributes(current);
                if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
                    throw new SdkException(
                        "persistence_path_invalid",
                        "persistence path must contain real directories only"
                    );
                }
                continue;
            }
            createAtomicOwnerDirectory(current);
        }
        verifyOwnerOnly(directory, true);
    }

    private static void createAtomicOwnerDirectory(Path path) throws IOException {
        try {
            PosixFileAttributeView view = Files.getFileAttributeView(
                path.getParent(),
                PosixFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS
            );
            if (view == null) {
                throw new SdkException(
                    "persistence_unsupported",
                    "owner-only POSIX persistence permissions are unavailable"
                );
            }
            Files.createDirectory(path, PosixFilePermissions.asFileAttribute(DIRECTORY_PERMISSIONS));
        } catch (FileAlreadyExistsException error) {
            BasicFileAttributes attributes = readAttributes(path);
            if (!attributes.isDirectory() || attributes.isSymbolicLink()) {
                throw error;
            }
        }
    }

    private static void createAtomicOwnerFileIfAbsent(Path path) throws IOException {
        try {
            createAtomicOwnerFile(path).close();
        } catch (FileAlreadyExistsException error) {
            verifyRegularFile(path);
        }
    }

    private static OwnedFile createAtomicOwnerFile(Path path) throws IOException {
        PosixFileAttributeView view = Files.getFileAttributeView(
            path.getParent(),
            PosixFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS
        );
        if (view == null) {
            throw new SdkException(
                "persistence_unsupported",
                "owner-only POSIX persistence permissions are unavailable"
            );
        }
        FileAttribute<?>[] attributes = new FileAttribute<?>[] {
            PosixFilePermissions.asFileAttribute(FILE_PERMISSIONS)
        };
        Set<OpenOption> options = new HashSet<>(Arrays.asList(
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS
        ));
        FileChannel channel = FileChannel.open(path, options, attributes);
        try {
            verifyRegularFile(path);
            Object key = fileKey(readAttributes(path), false);
            return new OwnedFile(path, channel, key);
        } catch (RuntimeException error) {
            try {
                channel.close();
            } catch (IOException closeError) {
                error.addSuppressed(closeError);
            }
            throw error;
        }
    }

    private static void verifyOwnedPath(OwnedFile file) {
        verifyRegularFile(file.path);
        if (!file.fileKey.equals(fileKey(readAttributes(file.path), false))) {
            throw new SdkException("persistence_replaced", "persistence temporary file was replaced");
        }
    }

    private static void verifyRegularFile(Path path) {
        BasicFileAttributes attributes = readAttributes(path);
        if (!attributes.isRegularFile() || attributes.isSymbolicLink()) {
            PersistenceCrypto.integrityFailure();
        }
        fileKey(attributes, false);
        verifyOwnerOnly(path, false);
        verifySingleLink(path);
    }

    private static void verifySingleLink(Path path) {
        try {
            Object value = Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS);
            if (value instanceof Number && ((Number) value).longValue() != 1L) {
                PersistenceCrypto.integrityFailure();
            }
        } catch (UnsupportedOperationException | IllegalArgumentException error) {
            // Link counts are not exposed by every Java filesystem provider.
        } catch (IOException error) {
            throw new SdkException(
                "persistence_integrity_error",
                "persistence file ownership is invalid"
            );
        }
    }

    private static BasicFileAttributes readAttributes(Path path) {
        try {
            return Files.readAttributes(
                path,
                BasicFileAttributes.class,
                LinkOption.NOFOLLOW_LINKS
            );
        } catch (IOException error) {
            throw new SdkException(
                "persistence_integrity_error",
                "persistence file ownership is invalid"
            );
        }
    }

    private static Object fileKey(BasicFileAttributes attributes, boolean directory) {
        if (directory ? !attributes.isDirectory() : !attributes.isRegularFile()) {
            PersistenceCrypto.integrityFailure();
        }
        Object value = attributes.fileKey();
        if (value == null) {
            throw new SdkException(
                "persistence_unsupported",
                "filesystem identity checks are unavailable"
            );
        }
        return value;
    }

    private static void verifyOwnerOnly(Path path, boolean directory) {
        PosixFileAttributeView view = Files.getFileAttributeView(
            path,
            PosixFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS
        );
        if (view == null) {
            throw new SdkException(
                "persistence_unsupported",
                "owner-only POSIX persistence permissions are unavailable"
            );
        }
        try {
            Set<PosixFilePermission> permissions = view.readAttributes().permissions();
            Set<PosixFilePermission> expected = directory ? DIRECTORY_PERMISSIONS : FILE_PERMISSIONS;
            if (!expected.containsAll(permissions)
                || !permissions.contains(PosixFilePermission.OWNER_READ)
                || !permissions.contains(PosixFilePermission.OWNER_WRITE)
                || (directory && !permissions.contains(PosixFilePermission.OWNER_EXECUTE))) {
                throw new SdkException(
                    "persistence_permissions_invalid",
                    "persistence permissions must be owner-only"
                );
            }
        } catch (IOException error) {
            throw new SdkException(
                "persistence_integrity_error",
                "persistence permissions could not be verified"
            );
        }
    }

    private static void verifyName(String name) {
        if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) {
            throw new IllegalArgumentException("unsafe persistence file name");
        }
    }

    private void ensureOpen() {
        if (closed) {
            throw new SdkException("persistence_closed", "persistence store is closed");
        }
    }

    private static void releaseQuietly(FileLock lock, FileChannel channel) {
        if (lock != null) {
            try {
                lock.release();
            } catch (IOException error) {
                // Best effort while closing a caller-owned persistence store.
            }
        }
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException error) {
                // Best effort while closing a caller-owned persistence store.
            }
        }
    }

    static void closeQuietly(OwnedFile file) {
        if (file == null) {
            return;
        }
        try {
            file.close();
        } catch (IOException error) {
            // A failed transaction remains guarded by its durable intent or temporary path.
        }
    }

    static final class FileData {
        final byte[] bytes;
        final FileIdentity identity;

        FileData(byte[] bytes, FileIdentity identity) {
            this.bytes = bytes;
            this.identity = identity;
        }
    }

    static final class FileIdentity {
        final Object fileKey;
        final long size;
        final byte[] digest;

        FileIdentity(Object fileKey, long size, byte[] digest) {
            this.fileKey = fileKey;
            this.size = size;
            this.digest = digest;
        }
    }

    static final class OwnedFile implements AutoCloseable {
        final Path path;
        final FileChannel channel;
        final Object fileKey;
        private boolean closed;

        OwnedFile(Path path, FileChannel channel, Object fileKey) {
            this.path = path;
            this.channel = channel;
            this.fileKey = fileKey;
        }

        @Override
        public void close() throws IOException {
            if (!closed) {
                closed = true;
                channel.close();
            }
        }
    }

    static final class Layout {
        final List<Path> recordFiles;
        final List<Path> temporaryFiles;
        final List<Path> purgeableFiles;
        final Path checkpointFile;
        final Path highWaterFile;
        final Path intentFile;
        final Path purgeIntentFile;

        Layout(
            List<Path> recordFiles,
            List<Path> temporaryFiles,
            List<Path> purgeableFiles,
            Path checkpointFile,
            Path highWaterFile,
            Path intentFile,
            Path purgeIntentFile
        ) {
            this.recordFiles = recordFiles;
            this.temporaryFiles = temporaryFiles;
            this.purgeableFiles = purgeableFiles;
            this.checkpointFile = checkpointFile;
            this.highWaterFile = highWaterFile;
            this.intentFile = intentFile;
            this.purgeIntentFile = purgeIntentFile;
        }
    }

    @FunctionalInterface
    interface WriteOperation {
        int write(FileChannel channel, ByteBuffer buffer) throws IOException;
    }

    @FunctionalInterface
    interface ReadOperation {
        int read(FileChannel channel, ByteBuffer buffer) throws IOException;
    }
}
