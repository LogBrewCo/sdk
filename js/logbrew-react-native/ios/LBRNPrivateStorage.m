#import "LBRNPrivateStorage.h"

#import <errno.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <unistd.h>

BOOL LBRNPreparePrivateRootDirectory(NSURL *directoryURL)
{
    if (!directoryURL.isFileURL) {
        return NO;
    }
    const char *path = directoryURL.fileSystemRepresentation;
    struct stat pathInfo;
    if (lstat(path, &pathInfo) != 0) {
        if (errno != ENOENT || mkdir(path, 0700) != 0) {
            return NO;
        }
    } else if (!S_ISDIR(pathInfo.st_mode) || S_ISLNK(pathInfo.st_mode)) {
        return NO;
    }

    int directoryFD = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (directoryFD < 0) {
        return NO;
    }
    struct stat openedInfo;
    BOOL prepared = fstat(directoryFD, &openedInfo) == 0
        && S_ISDIR(openedInfo.st_mode)
        && fchmod(directoryFD, 0700) == 0
        && lstat(path, &pathInfo) == 0
        && S_ISDIR(pathInfo.st_mode)
        && !S_ISLNK(pathInfo.st_mode)
        && openedInfo.st_dev == pathInfo.st_dev
        && openedInfo.st_ino == pathInfo.st_ino;
    close(directoryFD);
    return prepared;
}
