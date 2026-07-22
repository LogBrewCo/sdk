//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package logbrew

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	persistenceIntentVersion = byte(1)
	persistenceIntentSize    = 1 + 1 + sha256.Size
	maxPersistenceFileBytes  = int64(80 * 1024 * 1024)
)

type persistenceFileIdentity struct {
	device uint64
	inode  uint64
}

type unixPersistentFiles struct {
	directory         string
	directoryHandle   *os.File
	directoryIdentity persistenceFileIdentity
	lockHandle        *os.File
	lockIdentity      persistenceFileIdentity
	lockMarker        [sha256.Size]byte
	ownerPID          int
	purgeMode         bool
	fresh             bool
	fail              persistenceFailure
}

func openPersistentFiles(directory string, fail persistenceFailure, recover bool) (persistentFiles, error) {
	normalized, err := normalizePersistentDirectory(directory)
	if err != nil {
		return nil, err
	}
	if err := preparePersistentDirectory(normalized); err != nil {
		return nil, err
	}
	directoryHandle, directoryIdentity, err := openPinnedDirectory(normalized)
	if err != nil {
		return nil, err
	}
	files := &unixPersistentFiles{
		directory:         normalized,
		directoryHandle:   directoryHandle,
		directoryIdentity: directoryIdentity,
		ownerPID:          os.Getpid(),
		purgeMode:         !recover,
		fail:              fail,
	}
	if err := files.acquireLock(); err != nil {
		directoryHandle.Close()
		return nil, err
	}
	if err := files.validateLayout(); err != nil {
		files.close()
		return nil, err
	}
	if recover {
		if err := files.recoverTransaction(); err != nil {
			files.close()
			return nil, err
		}
	}
	return files, nil
}

func normalizePersistentDirectory(directory string) (string, error) {
	trimmed := strings.TrimSpace(directory)
	if trimmed == "" {
		return "", persistenceSDKError("persistence_configuration_error")
	}
	absolute, err := filepath.Abs(trimmed)
	if err != nil {
		return "", persistenceSDKError("persistence_configuration_error")
	}
	normalized := filepath.Clean(absolute)
	volume := filepath.VolumeName(normalized)
	if normalized == string(os.PathSeparator) || normalized == volume+string(os.PathSeparator) {
		return "", persistenceSDKError("persistence_configuration_error")
	}
	if info, err := os.Lstat(normalized); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", persistenceSDKError("persistence_unsupported")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", persistenceSDKError("persistence_io_error")
	}
	resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(normalized))
	if err != nil {
		return "", persistenceSDKError("persistence_unsupported")
	}
	return filepath.Join(resolvedParent, filepath.Base(normalized)), nil
}

func preparePersistentDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		parent := filepath.Dir(directory)
		parentInfo, parentErr := os.Lstat(parent)
		if parentErr != nil || !parentInfo.IsDir() || parentInfo.Mode()&os.ModeSymlink != 0 {
			return persistenceSDKError("persistence_unsupported")
		}
		if err := os.Mkdir(directory, 0o700); err != nil {
			return persistenceSDKError("persistence_io_error")
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			return persistenceSDKError("persistence_io_error")
		}
		if err := syncPersistentDirectory(filepath.Dir(directory)); err != nil {
			return err
		}
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return persistenceSDKError("persistence_integrity_error")
	}
	return syncPersistentDirectory(filepath.Dir(directory))
}

func syncPersistentDirectory(path string) error {
	handle, err := os.Open(path)
	if err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	defer handle.Close()
	if err := handle.Sync(); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	return nil
}

func openPinnedDirectory(path string) (*os.File, persistenceFileIdentity, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, persistenceFileIdentity{}, persistenceSDKError("persistence_unsupported")
	}
	handle := os.NewFile(uintptr(fd), filepath.Base(path))
	info, err := handle.Stat()
	if err != nil {
		handle.Close()
		return nil, persistenceFileIdentity{}, persistenceSDKError("persistence_io_error")
	}
	identity, err := verifyDirectoryInfo(info)
	if err != nil {
		handle.Close()
		return nil, persistenceFileIdentity{}, err
	}
	return handle, identity, nil
}

func verifyDirectoryInfo(info os.FileInfo) (persistenceFileIdentity, error) {
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_unsupported")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_unsupported")
	}
	return persistenceFileIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino)}, nil
}

func (f *unixPersistentFiles) acquireLock() error {
	path := f.path(persistentLockFile)
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return persistenceSDKError("persistence_integrity_error")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return persistenceSDKError("persistence_io_error")
	}
	created := false
	fd, err := syscall.Open(
		path,
		syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0o600,
	)
	if err == nil {
		created = true
	} else if errors.Is(err, syscall.EEXIST) {
		fd, err = syscall.Open(path, syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	}
	if err != nil {
		return persistenceSDKError("persistence_unsupported")
	}
	if created {
		if err := syscall.Fchmod(fd, 0o600); err != nil {
			syscall.Close(fd)
			return persistenceSDKError("persistence_unsupported")
		}
	}
	handle := os.NewFile(uintptr(fd), persistentLockFile)
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		handle.Close()
		return persistenceSDKError("persistence_in_use")
	}
	acquired := false
	defer func() {
		if !acquired {
			_ = syscall.Flock(fd, syscall.LOCK_UN)
			_ = handle.Close()
		}
	}()
	identity, err := f.verifyOpenFile(path, handle, !f.purgeMode)
	if err != nil {
		return err
	}
	var lockMarker [sha256.Size]byte
	fresh := false
	info, err := handle.Stat()
	if err != nil {
		return persistenceSDKError("persistence_integrity_error")
	}
	if created {
		if _, err := rand.Read(lockMarker[:]); err != nil {
			return persistenceSDKError("persistence_io_error")
		}
		if err := writeLockMarker(handle, lockMarker); err != nil {
			return persistenceSDKError("persistence_io_error")
		}
		if err := f.directoryHandle.Sync(); err != nil {
			return persistenceSDKError("persistence_io_error")
		}
		fresh = true
	} else if info.Size() == sha256.Size {
		if _, err := handle.ReadAt(lockMarker[:], 0); err != nil {
			return persistenceSDKError("persistence_integrity_error")
		}
		if !f.purgeMode && lockMarker == ([sha256.Size]byte{}) {
			if _, err := rand.Read(lockMarker[:]); err != nil {
				return persistenceSDKError("persistence_io_error")
			}
			if err := writeLockMarker(handle, lockMarker); err != nil {
				return err
			}
			fresh = true
		}
	} else if !f.purgeMode {
		return persistenceSDKError("persistence_integrity_error")
	}
	if current, err := f.verifyOpenFile(path, handle, !f.purgeMode); err != nil || current != identity {
		return persistenceSDKError("persistence_integrity_error")
	}
	f.lockHandle = handle
	f.lockIdentity = identity
	f.lockMarker = lockMarker
	f.fresh = fresh
	acquired = true
	return nil
}

func (f *unixPersistentFiles) ownerMarker() ([]byte, error) {
	if err := f.verifyBoundary(); err != nil {
		return nil, err
	}
	return append([]byte(nil), f.lockMarker[:]...), nil
}

func (f *unixPersistentFiles) freshBoundary() (bool, error) {
	if err := f.verifyBoundary(); err != nil {
		return false, err
	}
	return f.fresh, nil
}

func (f *unixPersistentFiles) verifyBoundary() error {
	if f.ownerPID != os.Getpid() || f.directoryHandle == nil || f.lockHandle == nil {
		return persistenceSDKError("persistence_owner_changed")
	}
	directoryInfo, err := f.directoryHandle.Stat()
	if err != nil {
		return persistenceSDKError("persistence_owner_changed")
	}
	directoryIdentity, err := verifyDirectoryInfo(directoryInfo)
	if err != nil || directoryIdentity != f.directoryIdentity {
		return persistenceSDKError("persistence_integrity_error")
	}
	pathInfo, err := os.Lstat(f.directory)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 {
		return persistenceSDKError("persistence_integrity_error")
	}
	pathIdentity, err := verifyDirectoryInfo(pathInfo)
	if err != nil || pathIdentity != f.directoryIdentity {
		return persistenceSDKError("persistence_integrity_error")
	}
	lockIdentity, err := f.verifyOpenFile(f.path(persistentLockFile), f.lockHandle, !f.purgeMode)
	if err != nil || lockIdentity != f.lockIdentity {
		return persistenceSDKError("persistence_integrity_error")
	}
	if f.purgeMode {
		return nil
	}
	var lockMarker [sha256.Size]byte
	if _, err := f.lockHandle.ReadAt(lockMarker[:], 0); err != nil || !bytes.Equal(lockMarker[:], f.lockMarker[:]) {
		return persistenceSDKError("persistence_integrity_error")
	}
	return nil
}

func (f *unixPersistentFiles) validateLayout() error {
	if err := f.verifyBoundary(); err != nil {
		return err
	}
	entries, err := os.ReadDir(f.directory)
	if err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	allowed := map[string]bool{
		persistentLockFile:   true,
		persistentKeyFile:    true,
		persistentQueueFile:  true,
		persistentTempFile:   true,
		persistentIntentFile: true,
	}
	for _, entry := range entries {
		if !allowed[entry.Name()] {
			return persistenceSDKError("persistence_integrity_error")
		}
		if entry.Name() == persistentLockFile {
			continue
		}
		if _, err := f.verifyPathFile(f.path(entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

func (f *unixPersistentFiles) exists(name string) (bool, error) {
	if err := f.verifyBoundary(); err != nil {
		return false, err
	}
	_, err := f.verifyPathFile(f.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (f *unixPersistentFiles) read(name string, maxBytes int64) ([]byte, error) {
	if err := f.verifyBoundary(); err != nil {
		return nil, err
	}
	if maxBytes <= 0 || maxBytes > maxPersistenceFileBytes {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	path := f.path(name)
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, os.ErrNotExist
		}
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	handle := os.NewFile(uintptr(fd), name)
	defer handle.Close()
	identity, err := f.verifyOpenFile(path, handle, false)
	if err != nil {
		return nil, err
	}
	info, err := handle.Stat()
	if err != nil || info.Size() < 0 || info.Size() > maxBytes {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	data := make([]byte, info.Size())
	if _, err := io.ReadFull(handle, data); err != nil {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	var extra [1]byte
	if count, err := handle.Read(extra[:]); count != 0 || err != io.EOF {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	after, err := f.verifyOpenFile(path, handle, false)
	if err != nil || after != identity {
		return nil, persistenceSDKError("persistence_integrity_error")
	}
	return data, nil
}

func (f *unixPersistentFiles) purge() error {
	if err := f.verifyBoundary(); err != nil {
		return err
	}
	if err := f.validateLayout(); err != nil {
		return err
	}
	for _, name := range []string{
		persistentIntentFile,
		persistentTempFile,
		persistentQueueFile,
		persistentKeyFile,
	} {
		exists, err := f.exists(name)
		if err != nil {
			return err
		}
		if exists {
			if err := f.removeVerified(name); err != nil {
				return err
			}
		}
	}
	if err := f.resetLockMarker(); err != nil {
		return err
	}
	if err := f.failAt("before_purge_sync"); err != nil {
		return err
	}
	return f.syncDirectory()
}

func (f *unixPersistentFiles) resetLockMarker() error {
	var purged [sha256.Size]byte
	if err := writeLockMarker(f.lockHandle, purged); err != nil {
		return err
	}
	f.lockMarker = purged
	return nil
}

func writeLockMarker(handle *os.File, marker [sha256.Size]byte) error {
	if err := handle.Truncate(0); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	count, err := handle.WriteAt(marker[:], 0)
	if err != nil || count != len(marker) {
		return persistenceSDKError("persistence_io_error")
	}
	if err := handle.Sync(); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	return nil
}

func (f *unixPersistentFiles) verifyOpenFile(path string, handle *os.File, lock bool) (persistenceFileIdentity, error) {
	info, err := handle.Stat()
	if err != nil {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_integrity_error")
	}
	identity, err := verifyRegularFileInfo(info)
	if err != nil {
		return persistenceFileIdentity{}, err
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_integrity_error")
	}
	pathIdentity, err := verifyRegularFileInfo(pathInfo)
	if err != nil || pathIdentity != identity {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_integrity_error")
	}
	if lock && info.Size() != 0 && info.Size() != sha256.Size {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_integrity_error")
	}
	return identity, nil
}

func (f *unixPersistentFiles) verifyPathFile(path string) (persistenceFileIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return persistenceFileIdentity{}, os.ErrNotExist
		}
		return persistenceFileIdentity{}, persistenceSDKError("persistence_io_error")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_integrity_error")
	}
	return verifyRegularFileInfo(info)
}

func verifyRegularFileInfo(info os.FileInfo) (persistenceFileIdentity, error) {
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_unsupported")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_unsupported")
	}
	if uint64(stat.Nlink) != 1 {
		return persistenceFileIdentity{}, persistenceSDKError("persistence_integrity_error")
	}
	return persistenceFileIdentity{device: uint64(stat.Dev), inode: uint64(stat.Ino)}, nil
}

func (f *unixPersistentFiles) removeVerified(name string) error {
	if _, err := f.verifyPathFile(f.path(name)); err != nil {
		return err
	}
	if err := os.Remove(f.path(name)); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	return nil
}

func (f *unixPersistentFiles) syncDirectory() error {
	if err := f.verifyBoundary(); err != nil {
		return err
	}
	if err := f.directoryHandle.Sync(); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	return nil
}

func (f *unixPersistentFiles) failAt(point string) error {
	if f.fail == nil {
		return nil
	}
	if err := f.fail(point); err != nil {
		return persistenceSDKError("persistence_io_error")
	}
	return nil
}

func (f *unixPersistentFiles) path(name string) string {
	return filepath.Join(f.directory, name)
}

func (f *unixPersistentFiles) close() error {
	if f == nil {
		return nil
	}
	var result error
	if f.lockHandle != nil {
		if f.ownerPID == os.Getpid() {
			if err := syscall.Flock(int(f.lockHandle.Fd()), syscall.LOCK_UN); err != nil {
				result = persistenceSDKError("persistence_io_error")
			}
		}
		if err := f.lockHandle.Close(); err != nil && result == nil {
			result = persistenceSDKError("persistence_io_error")
		}
		f.lockHandle = nil
	}
	if f.directoryHandle != nil {
		if err := f.directoryHandle.Close(); err != nil && result == nil {
			result = persistenceSDKError("persistence_io_error")
		}
		f.directoryHandle = nil
	}
	return result
}
