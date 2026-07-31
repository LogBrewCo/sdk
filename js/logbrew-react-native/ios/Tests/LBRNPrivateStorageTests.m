#import <Foundation/Foundation.h>
#import <sys/stat.h>

#import "../LBRNPrivateStorage.h"

static void Assert(BOOL condition, NSString *reason)
{
    if (!condition) {
        @throw [NSException exceptionWithName:@"LBRNPrivateStorageTestFailure"
                                       reason:reason
                                     userInfo:nil];
    }
}

int main(void)
{
    @autoreleasepool {
        NSFileManager *manager = [NSFileManager defaultManager];
        NSURL *parentURL = [[manager temporaryDirectory]
            URLByAppendingPathComponent:[NSString stringWithFormat:@"logbrew-rn-private-root-%@", [NSUUID UUID].UUIDString]
                            isDirectory:YES];
        NSURL *rootURL = [parentURL URLByAppendingPathComponent:@"Application Support"
                                                   isDirectory:YES];
        NSError *error = nil;
        Assert(
            [manager createDirectoryAtURL:parentURL
              withIntermediateDirectories:NO
                               attributes:nil
                                    error:&error],
            @"failed to create parent directory");
        @try {
            Assert(LBRNPreparePrivateRootDirectory(rootURL), @"fresh private root was not prepared");
            struct stat rootInfo;
            Assert(
                lstat(rootURL.fileSystemRepresentation, &rootInfo) == 0
                    && S_ISDIR(rootInfo.st_mode)
                    && !S_ISLNK(rootInfo.st_mode)
                    && (rootInfo.st_mode & 077) == 0,
                @"private root mode or type is unsafe");
            NSURL *outsideURL = [[manager temporaryDirectory]
                URLByAppendingPathComponent:[NSString stringWithFormat:@"logbrew-rn-private-outside-%@", [NSUUID UUID].UUIDString]
                                isDirectory:YES];
            NSURL *linkURL = [parentURL URLByAppendingPathComponent:@"linked-root" isDirectory:YES];
            Assert(
                [manager createDirectoryAtURL:outsideURL
                  withIntermediateDirectories:NO
                                   attributes:nil
                                        error:&error],
                @"failed to create outside directory");
            @try {
                Assert(
                    [manager createSymbolicLinkAtURL:linkURL
                                  withDestinationURL:outsideURL
                                               error:&error],
                    @"failed to create root symlink");
                Assert(
                    !LBRNPreparePrivateRootDirectory(linkURL),
                    @"private root preparation followed a symlink");
            } @finally {
                [manager removeItemAtURL:outsideURL error:nil];
            }
        } @finally {
            [manager removeItemAtURL:parentURL error:nil];
        }
        NSLog(@"ios private storage tests: 1 passed");
    }
    return 0;
}
