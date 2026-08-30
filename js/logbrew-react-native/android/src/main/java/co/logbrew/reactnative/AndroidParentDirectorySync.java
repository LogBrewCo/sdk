package co.logbrew.reactnative;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;

final class AndroidParentDirectorySync implements EventRecordStore.ParentDirectorySync {
  @Override
  public EventRecordStore.ParentDirectorySyncResult sync(File directory) {
    FileDescriptor descriptor;
    try {
      descriptor =
          Os.open(
              directory.getAbsolutePath(),
              OsConstants.O_RDONLY | OsConstants.O_CLOEXEC | OsConstants.O_NOFOLLOW,
              0);
    } catch (ErrnoException | RuntimeException error) {
      return EventRecordStore.ParentDirectorySyncResult.FAILED;
    }

    EventRecordStore.ParentDirectorySyncResult result;
    try {
      if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) {
        result = EventRecordStore.ParentDirectorySyncResult.FAILED;
      } else {
        result = syncDescriptor(descriptor);
      }
    } catch (ErrnoException | RuntimeException error) {
      result = EventRecordStore.ParentDirectorySyncResult.FAILED;
    }

    try {
      Os.close(descriptor);
    } catch (ErrnoException | RuntimeException error) {
      return EventRecordStore.ParentDirectorySyncResult.FAILED;
    }
    return result;
  }

  private static EventRecordStore.ParentDirectorySyncResult syncDescriptor(
      FileDescriptor descriptor) {
    try {
      Os.fsync(descriptor);
      return EventRecordStore.ParentDirectorySyncResult.SYNCHRONIZED;
    } catch (ErrnoException error) {
      return unsupportedDirectorySync(error.errno)
          ? EventRecordStore.ParentDirectorySyncResult.UNSUPPORTED
          : EventRecordStore.ParentDirectorySyncResult.FAILED;
    } catch (RuntimeException error) {
      return EventRecordStore.ParentDirectorySyncResult.FAILED;
    }
  }

  private static boolean unsupportedDirectorySync(int errno) {
    return errno == OsConstants.EINVAL
        || errno == OsConstants.ENOTSUP
        || errno == OsConstants.EOPNOTSUPP;
  }
}
