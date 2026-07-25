#import <Foundation/Foundation.h>
#import <unistd.h>

#import "../LBRNFatalRecordStore.h"

static NSUInteger passed = 0;

static void AssertEqual(id expected, id actual)
{
    if ((expected == nil && actual != nil) || ![expected isEqual:actual]) {
        @throw [NSException exceptionWithName:@"LBRNTestFailure"
                                       reason:[NSString stringWithFormat:@"expected %@ but got %@", expected, actual]
                                     userInfo:nil];
    }
}

static NSDictionary *Record(NSString *recordId, NSString *filename)
{
    return @{
        @"schemaVersion" : @1,
        @"id" : recordId,
        @"timestamp" : @"2026-07-25T12:00:00.000Z",
        @"errorName" : @"Error",
        @"stackFrames" : @[
            @{
                @"filename" : filename,
                @"line" : @12,
                @"column" : @34,
            }
        ],
        @"droppedRecords" : @0,
        @"corruptRecords" : @0,
    };
}

static void WithDirectory(void (^test)(NSURL *directoryURL))
{
    NSFileManager *manager = [NSFileManager defaultManager];
    NSURL *directoryURL = [[manager temporaryDirectory]
        URLByAppendingPathComponent:[NSString stringWithFormat:@"logbrew-rn-fatal-ios-%@", [NSUUID UUID].UUIDString]
                        isDirectory:YES];
    NSError *error = nil;
    if (![manager createDirectoryAtURL:directoryURL
           withIntermediateDirectories:YES
                            attributes:nil
                                 error:&error]) {
        @throw [NSException exceptionWithName:@"LBRNTestSetupFailure"
                                       reason:@"failed to create temporary directory"
                                     userInfo:nil];
    }
    @try {
        test(directoryURL);
    } @finally {
        [manager removeItemAtURL:directoryURL error:nil];
    }
}

static LBRNFatalRecordStore *StoreWithPreparation(
    NSURL *directoryURL,
    LBRNFatalDirectoryPreparation preparation)
{
    return [[LBRNFatalRecordStore alloc] initWithDirectoryURL:directoryURL
                                        directoryPreparation:preparation];
}

static LBRNFatalRecordStore *Store(NSURL *directoryURL)
{
    return StoreWithPreparation(directoryURL, ^BOOL(__unused NSURL *preparedURL) {
      return YES;
    });
}

static void TestNewStoreInstanceReadAndExactAcknowledgement(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      NSURL *recordURL = [directoryURL URLByAppendingPathComponent:LBRNFatalRecordFileName];
      __block BOOL preparedBeforeWrite = NO;
      LBRNFatalRecordStore *first =
          StoreWithPreparation(directoryURL, ^BOOL(__unused NSURL *preparedURL) {
            preparedBeforeWrite =
                ![[NSFileManager defaultManager] fileExistsAtPath:recordURL.path];
            return YES;
          });
      AssertEqual(@"stored", [first writeRecord:Record(@"evt_rn_fatal_first", @"main.jsbundle")][@"status"]);
      AssertEqual(@YES, @(preparedBeforeWrite));

      LBRNFatalRecordStore *afterDeath = Store(directoryURL);
      NSDictionary *pending = [afterDeath readRecord];
      AssertEqual(@"pending", pending[@"status"]);
      AssertEqual(@"evt_rn_fatal_first", pending[@"record"][@"id"]);
      AssertEqual(@"id_mismatch", [afterDeath acknowledgeRecordId:@"evt_rn_fatal_other"][@"status"]);
      AssertEqual(
          @"pending",
          [Store(directoryURL) readRecord][@"status"]);
      AssertEqual(@"acknowledged", [afterDeath acknowledgeRecordId:@"evt_rn_fatal_first"][@"status"]);
      AssertEqual(
          @"empty",
          [Store(directoryURL) readRecord][@"status"]);
      AssertEqual(@"empty", [afterDeath acknowledgeRecordId:@"evt_rn_fatal_first"][@"status"]);
    });
    passed += 1;
}

static void TestNewestRecordIsDroppedWithPersistentHealth(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      LBRNFatalRecordStore *store = Store(directoryURL);
      AssertEqual(@"stored", [store writeRecord:Record(@"evt_rn_fatal_oldest", @"main.jsbundle")][@"status"]);
      NSDictionary *dropped = [store writeRecord:Record(@"evt_rn_fatal_newest", @"index.ios.bundle")];
      AssertEqual(@"dropped_pending", dropped[@"status"]);
      AssertEqual(@1, dropped[@"droppedRecords"]);

      NSDictionary *pending =
          [Store(directoryURL) readRecord][@"record"];
      AssertEqual(@"evt_rn_fatal_oldest", pending[@"id"]);
      AssertEqual(@1, pending[@"droppedRecords"]);
      AssertEqual(@0, pending[@"corruptRecords"]);
    });
    passed += 1;
}

static void TestCorruptionIsDiscardedAndStoreRecovers(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      NSURL *recordURL = [directoryURL URLByAppendingPathComponent:LBRNFatalRecordFileName];
      [@"not a LogBrew record" writeToURL:recordURL atomically:NO encoding:NSUTF8StringEncoding error:nil];

      LBRNFatalRecordStore *store = Store(directoryURL);
      NSDictionary *corrupted = [store readRecord];
      AssertEqual(@"corrupt_discarded", corrupted[@"status"]);
      AssertEqual(@1, corrupted[@"corruptRecords"]);
      AssertEqual(@"empty", [store readRecord][@"status"]);
      AssertEqual(@"stored", [store writeRecord:Record(@"evt_rn_fatal_recovered", @"main.jsbundle")][@"status"]);
      AssertEqual(
          @"evt_rn_fatal_recovered",
          [Store(directoryURL) readRecord][@"record"][@"id"]);
    });
    passed += 1;
}

static void TestUnsafeAndOversizedRecordsAreRejected(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      LBRNFatalRecordStore *store = Store(directoryURL);
      AssertEqual(
          @"invalid_record",
          [store writeRecord:Record(@"evt_rn_fatal_absolute", @"/Users/private/source.js")][@"status"]);
      AssertEqual(
          @"invalid_record",
          [store writeRecord:Record(@"evt_rn_fatal_remote", @"https://private.example.test/main.js")][@"status"]);
      NSString *longId = [@"evt_rn_fatal_"
          stringByAppendingString:[@"" stringByPaddingToLength:90 withString:@"a" startingAtIndex:0]];
      AssertEqual(
          @"invalid_record",
          [store writeRecord:Record(longId, @"main.jsbundle")][@"status"]);
      NSMutableDictionary *nonzeroCounter =
          [Record(@"evt_rn_fatal_nonzero_counter", @"main.jsbundle") mutableCopy];
      nonzeroCounter[@"droppedRecords"] = @1;
      AssertEqual(@"invalid_record", [store writeRecord:nonzeroCounter][@"status"]);

      NSMutableArray *frames = [NSMutableArray array];
      for (NSUInteger index = 0; index < 25; index += 1) {
          [frames addObject:@{
              @"filename" : @"main.jsbundle",
              @"line" : @12,
              @"column" : @34,
          }];
      }
      NSMutableDictionary *tooManyFrames =
          [Record(@"evt_rn_fatal_many_frames", @"main.jsbundle") mutableCopy];
      tooManyFrames[@"stackFrames"] = frames;
      AssertEqual(@"invalid_record", [store writeRecord:tooManyFrames][@"status"]);
      AssertEqual(@"empty", [store readRecord][@"status"]);
    });
    passed += 1;
}

static void TestInterruptedTemporaryWriteIsIgnored(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      LBRNFatalRecordStore *store = Store(directoryURL);
      AssertEqual(@"stored", [store writeRecord:Record(@"evt_rn_fatal_committed", @"main.jsbundle")][@"status"]);
      NSURL *temporaryURL = [directoryURL URLByAppendingPathComponent:LBRNFatalRecordTemporaryFileName];
      [@"partial private bytes" writeToURL:temporaryURL atomically:NO encoding:NSUTF8StringEncoding error:nil];

      NSDictionary *pending =
          [Store(directoryURL) readRecord];
      AssertEqual(@"pending", pending[@"status"]);
      AssertEqual(@"evt_rn_fatal_committed", pending[@"record"][@"id"]);
      AssertEqual(@NO, @([[NSFileManager defaultManager] fileExistsAtPath:temporaryURL.path]));
    });
    passed += 1;
}

static void TestDiscardSupportsRollback(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      LBRNFatalRecordStore *store = Store(directoryURL);
      AssertEqual(@"stored", [store writeRecord:Record(@"evt_rn_fatal_rollback", @"main.jsbundle")][@"status"]);
      AssertEqual(@"discarded", [store discardRecord][@"status"]);
      AssertEqual(
          @"empty",
          [Store(directoryURL) readRecord][@"status"]);
      AssertEqual(@"empty", [store discardRecord][@"status"]);
    });
    passed += 1;
}

static void TestSymlinkReplacementIsRejectedAndFileIsPrivate(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      NSFileManager *manager = [NSFileManager defaultManager];
      NSURL *outsideURL = [[manager temporaryDirectory]
          URLByAppendingPathComponent:[NSString stringWithFormat:@"logbrew-rn-fatal-outside-%@",
                                                                [NSUUID UUID].UUIDString]];
      [@"outside sentinel" writeToURL:outsideURL atomically:NO encoding:NSUTF8StringEncoding error:nil];
      NSURL *recordURL = [directoryURL URLByAppendingPathComponent:LBRNFatalRecordFileName];
      NSError *linkError = nil;
      if (![manager createSymbolicLinkAtPath:recordURL.path
                        withDestinationPath:outsideURL.path
                                     error:&linkError]) {
          @throw [NSException exceptionWithName:@"LBRNTestSetupFailure"
                                         reason:@"failed to create record symlink"
                                       userInfo:nil];
      }

      @try {
          LBRNFatalRecordStore *store = Store(directoryURL);
          AssertEqual(
              @"storage_error",
              [store writeRecord:Record(@"evt_rn_fatal_symlink", @"main.jsbundle")][@"status"]);
          AssertEqual(
              @"outside sentinel",
              [NSString stringWithContentsOfURL:outsideURL encoding:NSUTF8StringEncoding error:nil]);
          NSDictionary *linkAttributes = [manager attributesOfItemAtPath:recordURL.path error:nil];
          AssertEqual(NSFileTypeSymbolicLink, linkAttributes[NSFileType]);

          [manager removeItemAtURL:recordURL error:nil];
          AssertEqual(
              @"stored",
              [store writeRecord:Record(@"evt_rn_fatal_private", @"main.jsbundle")][@"status"]);
          NSDictionary *recordAttributes = [manager attributesOfItemAtPath:recordURL.path error:nil];
          AssertEqual(@0600, recordAttributes[NSFilePosixPermissions]);
      } @finally {
          [manager removeItemAtURL:outsideURL error:nil];
      }
    });
    passed += 1;
}

static void TestFailedDirectoryPreparationNeverStoresARecord(void)
{
    WithDirectory(^(NSURL *directoryURL) {
      __block NSUInteger preparationCalls = 0;
      LBRNFatalRecordStore *store =
          StoreWithPreparation(directoryURL, ^BOOL(__unused NSURL *preparedURL) {
            preparationCalls += 1;
            return NO;
          });
      AssertEqual(
          @"storage_error",
          [store writeRecord:Record(@"evt_rn_fatal_archive_failure", @"main.jsbundle")][@"status"]);
      AssertEqual(@1, @(preparationCalls));
      AssertEqual(@"empty", [Store(directoryURL) readRecord][@"status"]);
    });
    passed += 1;
}

static void RunProcessCanary(NSString *mode, NSURL *directoryURL)
{
    LBRNFatalRecordStore *store = Store(directoryURL);
    if ([mode isEqualToString:@"write-hard-exit"]) {
        AssertEqual(
            @"stored",
            [store writeRecord:Record(@"evt_rn_fatal_process_canary", @"main.jsbundle")][@"status"]);
        _exit(93);
    }
    if ([mode isEqualToString:@"read-mismatched-ack"]) {
        NSDictionary *pending = [store readRecord];
        AssertEqual(@"pending", pending[@"status"]);
        AssertEqual(@"evt_rn_fatal_process_canary", pending[@"record"][@"id"]);
        AssertEqual(@"id_mismatch", [store acknowledgeRecordId:@"evt_rn_fatal_other"][@"status"]);
        AssertEqual(@"pending", [store readRecord][@"status"]);
        NSLog(@"ios process canary: mismatched ack retained");
        return;
    }
    if ([mode isEqualToString:@"exact-ack"]) {
        AssertEqual(
            @"acknowledged",
            [store acknowledgeRecordId:@"evt_rn_fatal_process_canary"][@"status"]);
        NSLog(@"ios process canary: exact ack removed");
        return;
    }
    if ([mode isEqualToString:@"read-empty"]) {
        AssertEqual(@"empty", [store readRecord][@"status"]);
        NSLog(@"ios process canary: fresh read empty");
        return;
    }
    @throw [NSException exceptionWithName:@"LBRNTestFailure"
                                   reason:@"unknown process mode"
                                 userInfo:nil];
}

int main(int argc, const char *argv[])
{
    @autoreleasepool {
        if (argc == 3) {
            RunProcessCanary(
                [NSString stringWithUTF8String:argv[1]],
                [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]] isDirectory:YES]);
            return 0;
        }
        TestNewStoreInstanceReadAndExactAcknowledgement();
        TestNewestRecordIsDroppedWithPersistentHealth();
        TestCorruptionIsDiscardedAndStoreRecovers();
        TestUnsafeAndOversizedRecordsAreRejected();
        TestInterruptedTemporaryWriteIsIgnored();
        TestSymlinkReplacementIsRejectedAndFileIsPrivate();
        TestDiscardSupportsRollback();
        TestFailedDirectoryPreparationNeverStoresARecord();
        NSLog(@"ios fatal record store tests: %lu passed", (unsigned long)passed);
    }
    return 0;
}
