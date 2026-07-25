package co.logbrew.reactnative;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;

final class AndroidParentDirectorySync implements FatalRecordStore.ParentDirectorySync {
  @Override
  public FatalRecordStore.ParentDirectorySyncResult sync(File directory) {
    FileDescriptor descriptor;
    try {
      descriptor =
          Os.open(
              directory.getAbsolutePath(),
              OsConstants.O_RDONLY | OsConstants.O_CLOEXEC | OsConstants.O_NOFOLLOW,
              0);
    } catch (ErrnoException | RuntimeException error) {
      return FatalRecordStore.ParentDirectorySyncResult.FAILED;
    }

    FatalRecordStore.ParentDirectorySyncResult result;
    try {
      if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) {
        result = FatalRecordStore.ParentDirectorySyncResult.FAILED;
      } else {
        result = syncDescriptor(descriptor);
      }
    } catch (ErrnoException | RuntimeException error) {
      result = FatalRecordStore.ParentDirectorySyncResult.FAILED;
    }

    try {
      Os.close(descriptor);
    } catch (ErrnoException | RuntimeException error) {
      return FatalRecordStore.ParentDirectorySyncResult.FAILED;
    }
    return result;
  }

  private static FatalRecordStore.ParentDirectorySyncResult syncDescriptor(
      FileDescriptor descriptor) {
    try {
      Os.fsync(descriptor);
      return FatalRecordStore.ParentDirectorySyncResult.SYNCHRONIZED;
    } catch (ErrnoException error) {
      return unsupportedDirectorySync(error.errno)
          ? FatalRecordStore.ParentDirectorySyncResult.UNSUPPORTED
          : FatalRecordStore.ParentDirectorySyncResult.FAILED;
    } catch (RuntimeException error) {
      return FatalRecordStore.ParentDirectorySyncResult.FAILED;
    }
  }

  private static boolean unsupportedDirectorySync(int errno) {
    return errno == OsConstants.EINVAL
        || errno == OsConstants.ENOTSUP
        || errno == OsConstants.EOPNOTSUPP;
  }
}
