#import <Foundation/Foundation.h>
#import <sys/stat.h>
#import <unistd.h>

#import "../LBRNEventRecordStore.h"

static NSUInteger passed = 0;

static void AssertEqual(id expected, id actual)
{
    if ((expected == nil && actual != nil) || ![expected isEqual:actual]) {
        @throw [NSException exceptionWithName:@"LBRNEventTestFailure"
                                       reason:[NSString stringWithFormat:@"expected %@ but got %@", expected, actual]
                                     userInfo:nil];
    }
}

static NSString *Event(NSString *eventId)
{
    return [NSString stringWithFormat:
                     @"{\"type\":\"log\",\"id\":\"%@\",\"timestamp\":\"2026-07-31T08:30:00.000Z\",\"attributes\":{\"level\":\"error\",\"message\":\"offline restart\"}}",
                     eventId];
}

static NSNumber *EventBytes(NSString *event)
{
    return @([event lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
}

static LBRNEventRecordStore *Store(NSURL *directoryURL)
{
    return [[LBRNEventRecordStore alloc]
        initWithDirectoryURL:directoryURL
        directoryPreparation:^BOOL(__unused NSURL *preparedURL) {
          return YES;
        }];
}

static void WithDirectory(void (^test)(NSURL *directoryURL))
{
    NSFileManager *manager = [NSFileManager defaultManager];
    NSURL *directoryURL = [[manager temporaryDirectory]
        URLByAppendingPathComponent:[NSString stringWithFormat:@"logbrew-rn-events-ios-%@", [NSUUID UUID].UUIDString]
                        isDirectory:YES];
    NSError *error = nil;
    if (![manager createDirectoryAtURL:directoryURL
           withIntermediateDirectories:YES
                            attributes:nil
                                 error:&error]) {
        @throw [NSException exceptionWithName:@"LBRNEventTestSetupFailure"
                                       reason:@"failed to create temporary directory"
                                     userInfo:nil];
    }
    @try {
        test(directoryURL);
    } @finally {
        [manager removeItemAtURL:directoryURL error:nil];
    }
}

static NSArray<NSURL *> *FilesWithSuffix(NSURL *directoryURL, NSString *suffix)
{
    NSArray<NSURL *> *files = [[NSFileManager defaultManager]
        contentsOfDirectoryAtURL:directoryURL
      includingPropertiesForKeys:nil
                         options:0
                           error:nil];
    NSPredicate *predicate = [NSPredicate predicateWithBlock:^BOOL(NSURL *url, __unused NSDictionary *bindings) {
      return [url.lastPathComponent hasSuffix:suffix];
    }];
    return [files filteredArrayUsingPredicate:predicate];
}

static void TestRestartOrderAndAcceptedPrefix(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      LBRNEventRecordStore *first = Store(directoryURL);
      NSString *firstEvent = Event(@"evt_first");
      NSString *secondEvent = Event(@"evt_second");
      AssertEqual(@"appended", [first appendSerializedEvent:firstEvent eventBytes:EventBytes(firstEvent)][@"status"]);
      AssertEqual(@"appended", [first appendSerializedEvent:secondEvent eventBytes:EventBytes(secondEvent)][@"status"]);

      LBRNEventRecordStore *afterDeath = Store(directoryURL);
      NSDictionary *loaded = [afterDeath loadRecords];
      AssertEqual(@"loaded", loaded[@"status"]);
      AssertEqual(@2, @([loaded[@"records"] count]));
      AssertEqual(firstEvent, loaded[@"records"][0][@"serializedEvent"]);
      AssertEqual(secondEvent, loaded[@"records"][1][@"serializedEvent"]);
      AssertEqual(@"storage_error", [afterDeath acknowledgeRecordCount:@3][@"status"]);
      AssertEqual(@"acknowledged", [afterDeath acknowledgeRecordCount:@1][@"status"]);

      NSDictionary *remainder = [Store(directoryURL) loadRecords];
      AssertEqual(@1, @([remainder[@"records"] count]));
      AssertEqual(secondEvent, remainder[@"records"][0][@"serializedEvent"]);
      AssertEqual(@"acknowledged", [afterDeath acknowledgeRecordCount:@1][@"status"]);
      AssertEqual(@0, @([[Store(directoryURL) loadRecords][@"records"] count]));

      NSString *afterEmpty = Event(@"evt_after_empty");
      AssertEqual(
          @"appended",
          [Store(directoryURL) appendSerializedEvent:afterEmpty eventBytes:EventBytes(afterEmpty)][@"status"]);
      NSURL *recordURL = FilesWithSuffix(directoryURL, LBRNEventRecordSuffix).firstObject;
      AssertEqual(@"event-00000000000000000003.record", recordURL.lastPathComponent);
    });
    passed += 1;
}

static void TestCorruptionPurgeAndSymlinkSafety(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      NSString *event = Event(@"evt_corrupt");
      LBRNEventRecordStore *store = Store(directoryURL);
      AssertEqual(@"appended", [store appendSerializedEvent:event eventBytes:EventBytes(event)][@"status"]);
      NSURL *recordURL = FilesWithSuffix(directoryURL, LBRNEventRecordSuffix).firstObject;
      [@"corrupt" writeToURL:recordURL atomically:NO encoding:NSUTF8StringEncoding error:nil];
      AssertEqual(@"storage_error", [Store(directoryURL) loadRecords][@"status"]);
      AssertEqual(@"purged", [Store(directoryURL) purgeRecords][@"status"]);
      AssertEqual(@0, @([[Store(directoryURL) loadRecords][@"records"] count]));

      NSURL *outsideURL = [[[NSFileManager defaultManager] temporaryDirectory]
          URLByAppendingPathComponent:[NSString stringWithFormat:@"logbrew-rn-events-outside-%@", [NSUUID UUID].UUIDString]];
      [@"outside sentinel" writeToURL:outsideURL atomically:YES encoding:NSUTF8StringEncoding error:nil];
      NSURL *symlinkURL = [directoryURL URLByAppendingPathComponent:@"event-00000000000000000009.record"];
      NSError *error = nil;
      if (![[NSFileManager defaultManager] createSymbolicLinkAtURL:symlinkURL
                                               withDestinationURL:outsideURL
                                                            error:&error]) {
          @throw [NSException exceptionWithName:@"LBRNEventTestSetupFailure"
                                         reason:@"failed to create symlink"
                                       userInfo:nil];
      }
      AssertEqual(@"storage_error", [Store(directoryURL) loadRecords][@"status"]);
      AssertEqual(@"storage_error", [Store(directoryURL) purgeRecords][@"status"]);
      AssertEqual(@"outside sentinel", [NSString stringWithContentsOfURL:outsideURL encoding:NSUTF8StringEncoding error:nil]);
      [[NSFileManager defaultManager] removeItemAtURL:outsideURL error:nil];
    });
    passed += 1;
}

static void TestInterruptedTemporaryWriteAndPrivateMode(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      NSString *event = Event(@"evt_committed");
      AssertEqual(@"appended", [Store(directoryURL) appendSerializedEvent:event eventBytes:EventBytes(event)][@"status"]);
      NSURL *temporaryURL = [directoryURL URLByAppendingPathComponent:@"event-00000000000000000002.record.tmp"];
      [@"partial" writeToURL:temporaryURL atomically:NO encoding:NSUTF8StringEncoding error:nil];
      NSDictionary *loaded = [Store(directoryURL) loadRecords];
      AssertEqual(@"loaded", loaded[@"status"]);
      AssertEqual(@1, @([loaded[@"records"] count]));
      AssertEqual(event, loaded[@"records"][0][@"serializedEvent"]);
      AssertEqual(@NO, @([[NSFileManager defaultManager] fileExistsAtPath:temporaryURL.path]));

      NSURL *recordURL = FilesWithSuffix(directoryURL, LBRNEventRecordSuffix).firstObject;
      struct stat info;
      if (lstat(recordURL.fileSystemRepresentation, &info) != 0) {
          @throw [NSException exceptionWithName:@"LBRNEventTestFailure" reason:@"stat failed" userInfo:nil];
      }
      AssertEqual(@0, @((info.st_mode & 077) == 0 ? 0 : 1));
      AssertEqual(
          @"storage_error",
          [Store(directoryURL) appendSerializedEvent:event eventBytes:@([EventBytes(event) integerValue] + 1)][@"status"]);
    });
    passed += 1;
}

static void TestRejectsNonASCIISequenceNames(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      NSURL *hostileURL = [directoryURL
          URLByAppendingPathComponent:@"event-0000000000000000001١.record"];
      [@"hostile" writeToURL:hostileURL atomically:NO encoding:NSUTF8StringEncoding error:nil];
      AssertEqual(@"storage_error", [Store(directoryURL) loadRecords][@"status"]);
      AssertEqual(@"storage_error", [Store(directoryURL) purgeRecords][@"status"]);
      AssertEqual(@YES, @([[NSFileManager defaultManager] fileExistsAtPath:hostileURL.path]));
    });
    passed += 1;
}

static int RunProcessMode(NSString *mode, NSURL *directoryURL)
{
    LBRNEventRecordStore *store = Store(directoryURL);
    if ([mode isEqualToString:@"write-hard-exit"]) {
        NSString *event = Event(@"evt_process_restart");
        AssertEqual(@"appended", [store appendSerializedEvent:event eventBytes:EventBytes(event)][@"status"]);
        _exit(94);
    }
    if ([mode isEqualToString:@"read-ack"]) {
        NSDictionary *loaded = [store loadRecords];
        AssertEqual(@1, @([loaded[@"records"] count]));
        AssertEqual(Event(@"evt_process_restart"), loaded[@"records"][0][@"serializedEvent"]);
        AssertEqual(@"acknowledged", [store acknowledgeRecordCount:@1][@"status"]);
        NSLog(@"ios event process canary: replayed and acknowledged");
        return 0;
    }
    if ([mode isEqualToString:@"read-empty"]) {
        AssertEqual(@0, @([[store loadRecords][@"records"] count]));
        NSLog(@"ios event process canary: accepted prefix stayed empty");
        return 0;
    }
    return 2;
}

int main(int argc, const char *argv[])
{
    @autoreleasepool {
        if (argc == 3) {
            return RunProcessMode(
                [NSString stringWithUTF8String:argv[1]],
                [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES]);
        }
        TestRestartOrderAndAcceptedPrefix();
        TestCorruptionPurgeAndSymlinkSafety();
        TestInterruptedTemporaryWriteAndPrivateMode();
        TestRejectsNonASCIISequenceNames();
        NSLog(@"ios event record store tests: %lu passed", (unsigned long)passed);
    }
    return 0;
}
