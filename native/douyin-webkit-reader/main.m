#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>
#import "media-coverage.h"
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static const long long kAudioMaxBytes=32LL*1024LL*1024LL;
static const long long kVideoMaxBytes=128LL*1024LL*1024LL;
static const long long kProbeBytes=8LL*1024LL*1024LL;
static int gExitCode=69;

static void Emit(NSDictionary *value) {
  NSError *error=nil;
  NSData *data=[NSJSONSerialization dataWithJSONObject:value
                                                options:0
                                                  error:&error];
  if (error!=nil||data==nil) {
    const char *fallback=
      "{\"version\":1,\"status\":\"error\",\"code\":\"internal_error\"}\n";
    write(STDOUT_FILENO,fallback,strlen(fallback));
    return;
  }
  write(STDOUT_FILENO,data.bytes,data.length);
  write(STDOUT_FILENO,"\n",1);
}

static int ErrorResult(NSString *code,int exitCode) {
  Emit(@{
    @"version":@1,
    @"status":@"error",
    @"code":code
  });
  return exitCode;
}

static BOOL ParseInteger(NSString *text,long long *value) {
  if (text.length<1||text.length>20) return NO;
  NSCharacterSet *notDigits=
    [[NSCharacterSet decimalDigitCharacterSet] invertedSet];
  if ([text rangeOfCharacterFromSet:notDigits].location!=NSNotFound) {
    return NO;
  }
  errno=0;
  char *end=NULL;
  long long parsed=strtoll(text.UTF8String,&end,10);
  if (errno!=0||end==text.UTF8String||*end!='\0') return NO;
  *value=parsed;
  return YES;
}

static BOOL CanonicalDouyinURL(NSString *text,NSString **mediaId) {
  NSURLComponents *components=
    [NSURLComponents componentsWithString:text];
  if (components==nil||
      ![components.scheme isEqualToString:@"https"]||
      ![components.host isEqualToString:@"www.douyin.com"]||
      components.port!=nil||
      components.user!=nil||
      components.password!=nil||
      components.query!=nil||
      components.fragment!=nil) {
    return NO;
  }
  NSString *path=components.percentEncodedPath;
  NSRegularExpression *expression=
    [NSRegularExpression
      regularExpressionWithPattern:@"^/video/([1-9][0-9]{9,23})$"
                           options:0
                             error:nil];
  NSTextCheckingResult *match=
    [expression firstMatchInString:path
                           options:0
                             range:NSMakeRange(0,path.length)];
  if (match==nil||
      ![components.string
        isEqualToString:
          [NSString stringWithFormat:@"https://www.douyin.com%@",path]]) {
    return NO;
  }
  if (mediaId!=NULL) {
    *mediaId=[path substringWithRange:[match rangeAtIndex:1]];
  }
  return YES;
}

static BOOL PrivateOutputDirectory(NSString *path) {
  if (![path isAbsolutePath]) return NO;
  struct stat info;
  if (lstat(path.fileSystemRepresentation,&info)!=0) return NO;
  return S_ISDIR(info.st_mode)&&
    info.st_uid==getuid()&&
    (info.st_mode&0077)==0;
}

static BOOL AllowedMediaURL(NSURL *url) {
  if (url==nil||url.absoluteString.length>8192||
      ![url.scheme isEqualToString:@"https"]||
      url.port!=nil||url.user!=nil||url.password!=nil||
      url.fragment!=nil) {
    return NO;
  }
  NSString *host=url.host.lowercaseString;
  return [host hasSuffix:@".douyinvod.com"]&&
    host.length>@".douyinvod.com".length;
}

static NSString *SHA256ForFile(NSString *path) {
  NSInputStream *stream=[NSInputStream inputStreamWithFileAtPath:path];
  [stream open];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uint8_t buffer[64*1024];
  BOOL failed=NO;
  while (YES) {
    NSInteger count=[stream read:buffer maxLength:sizeof(buffer)];
    if (count<0) {
      failed=YES;
      break;
    }
    if (count==0) break;
    CC_SHA256_Update(&context,buffer,(CC_LONG)count);
  }
  [stream close];
  if (failed) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest,&context);
  NSMutableString *hex=
    [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH*2];
  for (NSUInteger index=0;index<CC_SHA256_DIGEST_LENGTH;index++) {
    [hex appendFormat:@"%02x",digest[index]];
  }
  return hex;
}

static BOOL AudioTrackProducesSample(
  AVAsset *asset,AVAssetTrack *track
) {
  NSError *error=nil;
  AVAssetReader *reader=
    [[AVAssetReader alloc] initWithAsset:asset error:&error];
  if (reader==nil||error!=nil) return NO;
  AVAssetReaderTrackOutput *output=
    [[AVAssetReaderTrackOutput alloc] initWithTrack:track
                                      outputSettings:nil];
  if (![reader canAddOutput:output]) return NO;
  [reader addOutput:output];
  if (![reader startReading]) return NO;
  CMSampleBufferRef sample=[output copyNextSampleBuffer];
  BOOL valid=sample!=NULL;
  if (sample!=NULL) CFRelease(sample);
  [reader cancelReading];
  return valid;
}

static BOOL CompleteAudioFileCoversPlayer(
  NSString *path,long long playerDurationMs
) {
  AVURLAsset *asset=[AVURLAsset URLAssetWithURL:
    [NSURL fileURLWithPath:path] options:@{
      AVURLAssetPreferPreciseDurationAndTimingKey:@NO
    }];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSArray<AVAssetTrack *> *audioTracks=
    [asset tracksWithMediaType:AVMediaTypeAudio];
  NSArray<AVAssetTrack *> *videoTracks=
    [asset tracksWithMediaType:AVMediaTypeVideo];
  double seconds=CMTimeGetSeconds(asset.duration);
#pragma clang diagnostic pop
  if (
    audioTracks.count<1||
    videoTracks.count>0||
    !isfinite(seconds)||
    seconds<=0||
    seconds>=18000.0||
    !AudioTrackProducesSample(asset,audioTracks.firstObject)
  ) {
    return NO;
  }
  return LLWAudioDurationMatchesPlayer(
    llround(seconds*1000.0),playerDurationMs
  );
}

static BOOL VideoFrameAtTime(AVAsset *asset,double seconds) {
  AVAssetImageGenerator *generator=
    [[AVAssetImageGenerator alloc] initWithAsset:asset];
  generator.appliesPreferredTrackTransform=YES;
  generator.maximumSize=CGSizeMake(1920,1080);
  NSError *error=nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CGImageRef image=[generator
    copyCGImageAtTime:CMTimeMakeWithSeconds(seconds,600)
    actualTime:NULL
    error:&error];
#pragma clang diagnostic pop
  BOOL valid=image!=NULL&&error==nil;
  if (image!=NULL) CGImageRelease(image);
  return valid;
}

static BOOL VideoTrackProducesFrame(AVAsset *asset) {
  return VideoFrameAtTime(asset,0.1);
}

static BOOL CompleteVideoFileCoversPlayer(
  NSString *path,long long playerDurationMs
) {
  AVURLAsset *asset=[AVURLAsset URLAssetWithURL:
    [NSURL fileURLWithPath:path] options:@{
      AVURLAssetPreferPreciseDurationAndTimingKey:@NO
    }];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSArray<AVAssetTrack *> *audioTracks=
    [asset tracksWithMediaType:AVMediaTypeAudio];
  NSArray<AVAssetTrack *> *videoTracks=
    [asset tracksWithMediaType:AVMediaTypeVideo];
  double seconds=CMTimeGetSeconds(asset.duration);
#pragma clang diagnostic pop
  if (
    videoTracks.count<1||
    audioTracks.count>0||
    !isfinite(seconds)||
    seconds<=0||
    seconds>=18000.0||
    !LLWAudioDurationMatchesPlayer(
      llround(seconds*1000.0),playerDurationMs
    )
  ) {
    return NO;
  }
  return VideoFrameAtTime(asset,0.1)&&
    VideoFrameAtTime(asset,MAX(0.1,seconds*0.9));
}

@interface LLWMediaDownloader :
  NSObject<NSURLSessionDataDelegate,NSURLSessionTaskDelegate>
@property(nonatomic,copy) NSString *outputPath;
@property(nonatomic,copy) NSString *referer;
@property(nonatomic) long long maxBytes;
@property(nonatomic) long long receivedBytes;
@property(nonatomic) BOOL responseAccepted;
@property(nonatomic) BOOL exceeded;
@property(nonatomic) NSInteger statusCode;
@property(nonatomic) NSInteger errorCode;
@property(nonatomic) BOOL timedOut;
@property(nonatomic) BOOL hadCompletionError;
@property(nonatomic) BOOL partialContent;
@property(nonatomic) long long sourceTotalBytes;
@property(nonatomic,strong) NSFileHandle *fileHandle;
@property(nonatomic,strong) NSURLSession *session;
@property(nonatomic) dispatch_semaphore_t semaphore;
@property(nonatomic,strong) NSError *completionError;
- (BOOL)downloadURL:(NSURL *)url
             output:(NSString *)output
            referer:(NSString *)referer
           maxBytes:(long long)maxBytes
          timeoutMs:(long long)timeoutMs;
@end

@implementation LLWMediaDownloader
- (BOOL)downloadURL:(NSURL *)url
             output:(NSString *)output
            referer:(NSString *)referer
           maxBytes:(long long)maxBytes
          timeoutMs:(long long)timeoutMs {
  if (!AllowedMediaURL(url)||maxBytes<1||maxBytes>kVideoMaxBytes) return NO;
  int descriptor=open(output.fileSystemRepresentation,
                      O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,0600);
  if (descriptor<0) return NO;
  close(descriptor);
  self.outputPath=output;
  self.referer=referer;
  self.maxBytes=maxBytes;
  self.receivedBytes=0;
  self.responseAccepted=NO;
  self.exceeded=NO;
  self.statusCode=0;
  self.errorCode=0;
  self.partialContent=NO;
  self.sourceTotalBytes=0;
  self.fileHandle=[NSFileHandle fileHandleForWritingAtPath:output];
  if (self.fileHandle==nil) return NO;
  self.semaphore=dispatch_semaphore_create(0);

  NSURLSessionConfiguration *configuration=
    [NSURLSessionConfiguration ephemeralSessionConfiguration];
  configuration.HTTPCookieAcceptPolicy=NSHTTPCookieAcceptPolicyNever;
  configuration.HTTPShouldSetCookies=NO;
  configuration.HTTPCookieStorage=nil;
  configuration.URLCache=nil;
  configuration.requestCachePolicy=NSURLRequestReloadIgnoringLocalCacheData;
  configuration.timeoutIntervalForRequest=
    MAX(1.0,(NSTimeInterval)timeoutMs/1000.0);
  configuration.timeoutIntervalForResource=
    MAX(1.0,(NSTimeInterval)timeoutMs/1000.0);
  NSOperationQueue *queue=[[NSOperationQueue alloc] init];
  queue.maxConcurrentOperationCount=1;
  self.session=[NSURLSession sessionWithConfiguration:configuration
                                             delegate:self
                                        delegateQueue:queue];
  NSMutableURLRequest *request=
    [NSMutableURLRequest requestWithURL:url
                           cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                       timeoutInterval:configuration.timeoutIntervalForRequest];
  [request setValue:
    [NSString stringWithFormat:@"bytes=0-%lld",maxBytes-1]
    forHTTPHeaderField:@"Range"];
  [request setValue:referer forHTTPHeaderField:@"Referer"];
  [request setValue:
    @"Mozilla/5.0 (Macintosh; Intel Mac OS X) "
     "AppleWebKit/605.1.15 Safari/605.1.15"
    forHTTPHeaderField:@"User-Agent"];
  NSURLSessionDataTask *task=[self.session dataTaskWithRequest:request];
  [task resume];
  dispatch_time_t waitUntil=dispatch_time(
    DISPATCH_TIME_NOW,(int64_t)((timeoutMs+1000)*NSEC_PER_MSEC)
  );
  BOOL timedOut=
    dispatch_semaphore_wait(self.semaphore,waitUntil)!=0;
  self.timedOut=timedOut;
  self.hadCompletionError=self.completionError!=nil;
  if (timedOut) {
    [task cancel];
  }
  [self.fileHandle closeFile];
  [self.session invalidateAndCancel];
  BOOL success=!timedOut&&self.completionError==nil&&
    self.responseAccepted&&!self.exceeded&&self.receivedBytes>0;
  if (!success) {
    unlink(output.fileSystemRepresentation);
  }
  return success;
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
 willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler {
  (void)session;
  (void)task;
  (void)response;
  if (!AllowedMediaURL(request.URL)) {
    completionHandler(nil);
    return;
  }
  NSMutableURLRequest *next=[request mutableCopy];
  [next setValue:
    [NSString stringWithFormat:@"bytes=0-%lld",self.maxBytes-1]
    forHTTPHeaderField:@"Range"];
  [next setValue:self.referer forHTTPHeaderField:@"Referer"];
  [next setValue:nil forHTTPHeaderField:@"Cookie"];
  completionHandler(next);
}

- (void)URLSession:(NSURLSession *)session
      dataTask:(NSURLSessionDataTask *)dataTask
 didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  (void)session;
  (void)dataTask;
  if (![response isKindOfClass:[NSHTTPURLResponse class]]||
      !AllowedMediaURL(response.URL)) {
    completionHandler(NSURLSessionResponseCancel);
    return;
  }
  NSHTTPURLResponse *http=(NSHTTPURLResponse *)response;
  self.statusCode=http.statusCode;
  self.partialContent=http.statusCode==206;
  NSString *contentRange=[http valueForHTTPHeaderField:@"Content-Range"];
  NSRegularExpression *totalExpression=
    [NSRegularExpression
      regularExpressionWithPattern:@"/([0-9]+)$"
                           options:0
                             error:nil];
  NSTextCheckingResult *totalMatch=
    [totalExpression firstMatchInString:contentRange?:@""
                                options:0
                                  range:NSMakeRange(0,(contentRange?:@"").length)];
  if (totalMatch!=nil) {
    NSString *total=[contentRange substringWithRange:
      [totalMatch rangeAtIndex:1]];
    long long parsed=0;
    if (ParseInteger(total,&parsed)) self.sourceTotalBytes=parsed;
  }
  if (
    self.sourceTotalBytes==0&&
    http.statusCode==200&&
    response.expectedContentLength>0
  ) {
    self.sourceTotalBytes=response.expectedContentLength;
  }
  BOOL status=http.statusCode==200||http.statusCode==206;
  BOOL oversizedWhole=
    http.statusCode==200&&response.expectedContentLength>self.maxBytes;
  if (!status||oversizedWhole) {
    completionHandler(NSURLSessionResponseCancel);
    return;
  }
  self.responseAccepted=YES;
  completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session
      dataTask:(NSURLSessionDataTask *)dataTask
 didReceiveData:(NSData *)data {
  (void)session;
  if (self.receivedBytes+(long long)data.length>self.maxBytes) {
    self.exceeded=YES;
    [dataTask cancel];
    return;
  }
  @try {
    [self.fileHandle writeData:data];
    self.receivedBytes+=(long long)data.length;
  } @catch (__unused NSException *exception) {
    self.exceeded=YES;
    [dataTask cancel];
  }
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
 didCompleteWithError:(NSError *)error {
  (void)session;
  (void)task;
  self.completionError=error;
  self.errorCode=error.code;
  dispatch_semaphore_signal(self.semaphore);
}
@end

@interface LLWDouyinReader : NSObject<WKNavigationDelegate>
@property(nonatomic,copy) NSString *pageURL;
@property(nonatomic,copy) NSString *mediaId;
@property(nonatomic,copy) NSString *outputDirectory;
@property(nonatomic) long long deadlineMs;
@property(nonatomic) BOOL finished;
@property(nonatomic) BOOL acquisitionStarted;
@property(nonatomic) NSInteger pollCount;
@property(nonatomic) NSInteger readyPollCount;
@property(nonatomic) double maxObservedDuration;
@property(nonatomic,strong) NSArray *latestMediaURLs;
@property(nonatomic,strong) WKWebView *webView;
@property(nonatomic,strong) NSWindow *window;
- (instancetype)initWithURL:(NSString *)pageURL
                    mediaId:(NSString *)mediaId
             outputDirectory:(NSString *)outputDirectory
                 deadlineMs:(long long)deadlineMs;
- (void)start;
@end

@implementation LLWDouyinReader
- (instancetype)initWithURL:(NSString *)pageURL
                    mediaId:(NSString *)mediaId
             outputDirectory:(NSString *)outputDirectory
                 deadlineMs:(long long)deadlineMs {
  self=[super init];
  if (self) {
    _pageURL=[pageURL copy];
    _mediaId=[mediaId copy];
    _outputDirectory=[outputDirectory copy];
    _deadlineMs=deadlineMs;
  }
  return self;
}

- (void)start {
  WKWebViewConfiguration *configuration=
    [[WKWebViewConfiguration alloc] init];
  configuration.websiteDataStore=
    [WKWebsiteDataStore nonPersistentDataStore];
  configuration.preferences.javaScriptCanOpenWindowsAutomatically=NO;
  configuration.mediaTypesRequiringUserActionForPlayback=
    WKAudiovisualMediaTypeNone;
  self.webView=[[WKWebView alloc]
    initWithFrame:NSMakeRect(0,0,1024,768)
    configuration:configuration];
  self.webView.navigationDelegate=self;
  self.window=[[NSWindow alloc]
    initWithContentRect:NSMakeRect(-10000,-10000,1024,768)
    styleMask:NSWindowStyleMaskBorderless
    backing:NSBackingStoreBuffered
    defer:NO];
  self.window.releasedWhenClosed=NO;
  self.window.alphaValue=0.01;
  self.window.contentView=self.webView;
  [self.window orderFront:nil];

  NSMutableURLRequest *request=[
    NSMutableURLRequest requestWithURL:[NSURL URLWithString:self.pageURL]
    cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
    timeoutInterval:(NSTimeInterval)self.deadlineMs/1000.0
  ];
  [request setValue:nil forHTTPHeaderField:@"Cookie"];
  [self.webView loadRequest:request];
  __weak typeof(self) weakSelf=self;
  dispatch_after(
    dispatch_time(DISPATCH_TIME_NOW,
      (int64_t)(self.deadlineMs*NSEC_PER_MSEC)),
    dispatch_get_main_queue(),^{
      if (!weakSelf.finished) [weakSelf finishError:@"media_unavailable"];
    }
  );
}

- (void)webView:(WKWebView *)webView
 decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
 decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  (void)webView;
  if (navigationAction.targetFrame.isMainFrame) {
    NSString *target=navigationAction.request.URL.absoluteString;
    if (![target isEqualToString:self.pageURL]) {
      decisionHandler(WKNavigationActionPolicyCancel);
      [self finishError:@"navigation_blocked"];
      return;
    }
  }
  decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView
 didFinishNavigation:(WKNavigation *)navigation {
  (void)webView;
  (void)navigation;
  [self pollPlayer];
}

- (void)webView:(WKWebView *)webView
 didFailNavigation:(WKNavigation *)navigation
       withError:(NSError *)error {
  (void)webView;
  (void)navigation;
  (void)error;
  [self finishError:@"page_load_failed"];
}

- (void)webView:(WKWebView *)webView
 didFailProvisionalNavigation:(WKNavigation *)navigation
       withError:(NSError *)error {
  (void)webView;
  (void)navigation;
  (void)error;
  [self finishError:@"page_load_failed"];
}

- (void)pollPlayer {
  if (self.finished||self.acquisitionStarted) return;
  self.pollCount+=1;
  NSString *script=
    @"(() => {"
     "const allowed = u => {"
       "try {"
         "const x = new URL(u);"
         "return x.protocol === 'https:' && "
           "x.hostname.endsWith('.douyinvod.com');"
       "} catch (_) { return false; }"
     "};"
     "const urls = [];"
     "for (const e of performance.getEntriesByType('resource')) {"
       "if (allowed(e.name) && !urls.includes(e.name)) urls.push(e.name);"
       "if (urls.length >= 16) break;"
     "}"
     "let duration = 0;"
     "let ready = false;"
     "for (const v of document.querySelectorAll('video')) {"
       "if (v.readyState >= 2) ready = true;"
       "if (Number.isFinite(v.duration) && v.duration > duration) "
         "duration = v.duration;"
       "if (allowed(v.currentSrc) && !urls.includes(v.currentSrc) && "
         "urls.length < 16) urls.push(v.currentSrc);"
     "}"
     "return {urls, duration, ready};"
    "})()";
  __weak typeof(self) weakSelf=self;
  [self.webView evaluateJavaScript:script completionHandler:
    ^(id value,NSError *error) {
      typeof(self) selfRef=weakSelf;
      if (selfRef==nil||selfRef.finished) return;
      NSDictionary *result=
        [value isKindOfClass:[NSDictionary class]]?value:nil;
      NSArray *urls=
        [result[@"urls"] isKindOfClass:[NSArray class]]
          ?result[@"urls"]:@[];
      NSNumber *duration=
        [result[@"duration"] isKindOfClass:[NSNumber class]]
          ?result[@"duration"]:@0;
      BOOL ready=[result[@"ready"] boolValue];
      if (error==nil&&ready&&urls.count>=2&&
          duration.doubleValue>0&&duration.doubleValue<18000.0) {
        selfRef.readyPollCount+=1;
        selfRef.maxObservedDuration=MAX(
          selfRef.maxObservedDuration,duration.doubleValue
        );
        selfRef.latestMediaURLs=urls;
      }
      if (selfRef.readyPollCount>=10&&
          selfRef.latestMediaURLs.count>=2&&
          selfRef.maxObservedDuration>0) {
        selfRef.acquisitionStarted=YES;
        [selfRef acquireURLs:selfRef.latestMediaURLs
                    duration:selfRef.maxObservedDuration];
        return;
      }
      if (selfRef.pollCount>=120) {
        [selfRef finishError:@"player_unavailable"];
        return;
      }
      dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC),
        dispatch_get_main_queue(),^{
          [weakSelf pollPlayer];
        }
      );
    }
  ];
}

- (void)acquireURLs:(NSArray *)rawURLs duration:(double)duration {
  NSString *pageURL=[self.pageURL copy];
  NSString *outputDirectory=[self.outputDirectory copy];
  NSString *mediaId=[self.mediaId copy];
  long long deadlineMs=self.deadlineMs;
  __weak typeof(self) weakSelf=self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
    NSMutableArray<NSString *> *created=[NSMutableArray array];
    NSString *audioPath=nil;
    NSString *videoPath=nil;
    long long audioBytes=0;
    long long videoBytes=0;
    NSInteger width=0;
    NSInteger height=0;
    BOOL audioPartial=NO;
    BOOL videoPartial=NO;
    NSUInteger candidateIndex=0;
    NSUInteger downloadedCount=0;
    NSUInteger audioOnlyCount=0;
    NSUInteger videoOnlyCount=0;
    NSUInteger combinedCount=0;
    NSInteger firstHTTPStatus=0;
    NSInteger firstErrorCode=0;
    BOOL firstResponseAccepted=NO;
    BOOL firstExceeded=NO;
    BOOL firstTimedOut=NO;
    BOOL firstHadError=NO;
    long long firstReceivedBytes=0;
    long long verifiedDurationMs=llround(duration*1000.0);

    for (id raw in rawURLs) {
      if (![raw isKindOfClass:[NSString class]]||
          candidateIndex>=16) continue;
      NSURL *url=[NSURL URLWithString:raw];
      if (!AllowedMediaURL(url)) continue;
      NSString *candidate=[
        outputDirectory stringByAppendingPathComponent:
          [NSString stringWithFormat:@".douyin-candidate-%02lu.mp4",
            (unsigned long)candidateIndex++]
      ];
      LLWMediaDownloader *downloader=
        [[LLWMediaDownloader alloc] init];
      BOOL downloaded=[downloader downloadURL:url
                                       output:candidate
                                      referer:pageURL
                                     maxBytes:kProbeBytes
                                    timeoutMs:MIN(deadlineMs,30000)];
      if (!downloaded) {
        if (firstHTTPStatus==0&&firstErrorCode==0) {
          firstHTTPStatus=downloader.statusCode;
          firstErrorCode=downloader.errorCode;
          firstResponseAccepted=downloader.responseAccepted;
          firstExceeded=downloader.exceeded;
          firstTimedOut=downloader.timedOut;
          firstHadError=downloader.hadCompletionError;
          firstReceivedBytes=downloader.receivedBytes;
        }
        continue;
      }
      downloadedCount+=1;
      [created addObject:candidate];

      AVURLAsset *asset=[AVURLAsset URLAssetWithURL:
        [NSURL fileURLWithPath:candidate] options:@{
          AVURLAssetPreferPreciseDurationAndTimingKey:@NO
        }];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      NSArray<AVAssetTrack *> *audioTracks=
        [asset tracksWithMediaType:AVMediaTypeAudio];
      NSArray<AVAssetTrack *> *videoTracks=
        [asset tracksWithMediaType:AVMediaTypeVideo];
#pragma clang diagnostic pop
      BOOL hasAudio=audioTracks.count>0;
      BOOL hasVideo=videoTracks.count>0;
      if (hasAudio&&
          !AudioTrackProducesSample(asset,audioTracks.firstObject)) {
        hasAudio=NO;
      }
      if (hasVideo&&!VideoTrackProducesFrame(asset)) {
        hasVideo=NO;
      }
      if (hasAudio&&hasVideo) combinedCount+=1;
      else if (hasAudio) audioOnlyCount+=1;
      else if (hasVideo) videoOnlyCount+=1;
      NSDictionary *attributes=
        [[NSFileManager defaultManager]
          attributesOfItemAtPath:candidate error:nil];
      long long byteSize=[attributes[NSFileSize] longLongValue];

      if (hasAudio&&!hasVideo&&audioPath==nil) {
        NSString *publishCandidate=candidate;
        long long publishBytes=byteSize;
        LLWAudioObjectDecision decision=
          LLWAudioObjectCoverageDecision(
            downloader.sourceTotalBytes,
            downloader.receivedBytes,
            kAudioMaxBytes
          );
        BOOL audioComplete=
          decision==LLWAudioObjectCompletePresent&&
          CompleteAudioFileCoversPlayer(
            candidate,verifiedDurationMs
          );
        if (decision==LLWAudioObjectFetchComplete) {
          NSString *completeCandidate=[
            outputDirectory stringByAppendingPathComponent:
              [NSString stringWithFormat:
                @".douyin-candidate-%02lu-complete.m4a",
                (unsigned long)candidateIndex]
          ];
          LLWMediaDownloader *completeDownloader=
            [[LLWMediaDownloader alloc] init];
          BOOL completeDownloaded=[
            completeDownloader
              downloadURL:url
              output:completeCandidate
              referer:pageURL
              maxBytes:downloader.sourceTotalBytes
              timeoutMs:MIN(deadlineMs,30000)
          ];
          if (completeDownloaded) {
            [created addObject:completeCandidate];
            NSDictionary *completeAttributes=[
              [NSFileManager defaultManager]
                attributesOfItemAtPath:completeCandidate
                                  error:nil
            ];
            long long completeBytes=[
              completeAttributes[NSFileSize] longLongValue
            ];
            BOOL exactBytes=
              completeBytes==downloader.sourceTotalBytes&&
              completeDownloader.receivedBytes==
                downloader.sourceTotalBytes&&
              (
                completeDownloader.sourceTotalBytes==0||
                completeDownloader.sourceTotalBytes==
                  downloader.sourceTotalBytes
              );
            if (
              exactBytes&&
              CompleteAudioFileCoversPlayer(
                completeCandidate,verifiedDurationMs
              )
            ) {
              publishCandidate=completeCandidate;
              publishBytes=completeBytes;
              audioComplete=YES;
            } else {
              unlink(completeCandidate.fileSystemRepresentation);
              [created removeObject:completeCandidate];
            }
          }
        }
        audioPath=[
          outputDirectory stringByAppendingPathComponent:@"douyin-audio.m4a"
        ];
        if ([[NSFileManager defaultManager]
             moveItemAtPath:publishCandidate
                     toPath:audioPath
                      error:nil]) {
          [created removeObject:publishCandidate];
          [created addObject:audioPath];
          audioBytes=publishBytes;
          audioPartial=!audioComplete;
          if (![publishCandidate isEqualToString:candidate]) {
            unlink(candidate.fileSystemRepresentation);
            [created removeObject:candidate];
          }
        } else {
          audioPath=nil;
        }
      } else if (hasVideo&&!hasAudio&&videoPath==nil) {
        NSString *publishCandidate=candidate;
        long long publishBytes=byteSize;
        LLWAudioObjectDecision decision=
          LLWAudioObjectCoverageDecision(
            downloader.sourceTotalBytes,
            downloader.receivedBytes,
            kVideoMaxBytes
          );
        BOOL videoComplete=
          decision==LLWAudioObjectCompletePresent&&
          CompleteVideoFileCoversPlayer(
            candidate,verifiedDurationMs
          );
        if (decision==LLWAudioObjectFetchComplete) {
          NSString *completeCandidate=[
            outputDirectory stringByAppendingPathComponent:
              [NSString stringWithFormat:
                @".douyin-candidate-%02lu-complete.mp4",
                (unsigned long)candidateIndex]
          ];
          LLWMediaDownloader *completeDownloader=
            [[LLWMediaDownloader alloc] init];
          BOOL completeDownloaded=[
            completeDownloader
              downloadURL:url
              output:completeCandidate
              referer:pageURL
              maxBytes:downloader.sourceTotalBytes
              timeoutMs:MIN(deadlineMs,30000)
          ];
          if (completeDownloaded) {
            [created addObject:completeCandidate];
            NSDictionary *completeAttributes=[
              [NSFileManager defaultManager]
                attributesOfItemAtPath:completeCandidate
                                  error:nil
            ];
            long long completeBytes=[
              completeAttributes[NSFileSize] longLongValue
            ];
            BOOL exactBytes=
              completeBytes==downloader.sourceTotalBytes&&
              completeDownloader.receivedBytes==
                downloader.sourceTotalBytes&&
              (
                completeDownloader.sourceTotalBytes==0||
                completeDownloader.sourceTotalBytes==
                  downloader.sourceTotalBytes
              );
            if (
              exactBytes&&
              CompleteVideoFileCoversPlayer(
                completeCandidate,verifiedDurationMs
              )
            ) {
              publishCandidate=completeCandidate;
              publishBytes=completeBytes;
              videoComplete=YES;
            } else {
              unlink(completeCandidate.fileSystemRepresentation);
              [created removeObject:completeCandidate];
            }
          }
        }
        videoPath=[
          outputDirectory stringByAppendingPathComponent:@"douyin-video.mp4"
        ];
        AVAssetTrack *track=videoTracks.firstObject;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        CGSize natural=CGSizeApplyAffineTransform(
          track.naturalSize,track.preferredTransform
        );
#pragma clang diagnostic pop
        if ([[NSFileManager defaultManager]
             moveItemAtPath:publishCandidate
                     toPath:videoPath
                      error:nil]) {
          [created removeObject:publishCandidate];
          [created addObject:videoPath];
          videoBytes=publishBytes;
          videoPartial=!videoComplete;
          width=(NSInteger)llround(fabs(natural.width));
          height=(NSInteger)llround(fabs(natural.height));
          if (![publishCandidate isEqualToString:candidate]) {
            unlink(candidate.fileSystemRepresentation);
            [created removeObject:candidate];
          }
        } else {
          videoPath=nil;
        }
      }
      if ([created containsObject:candidate]) {
        unlink(candidate.fileSystemRepresentation);
        [created removeObject:candidate];
      }
      if (audioPath!=nil&&videoPath!=nil) break;
    }

    NSString *audioHash=audioPath?SHA256ForFile(audioPath):nil;
    NSString *videoHash=videoPath?SHA256ForFile(videoPath):nil;
    long long durationMs=verifiedDurationMs;
    if (audioPath==nil||videoPath==nil||
        audioHash.length!=64||videoHash.length!=64||
        audioBytes<1||audioBytes>kAudioMaxBytes||
        videoBytes<1||videoBytes>kVideoMaxBytes||
        durationMs<1||durationMs>=18000000||
        width<1||height<1||width>7680||height>4320) {
      for (NSString *path in created) {
        unlink(path.fileSystemRepresentation);
      }
      dispatch_async(dispatch_get_main_queue(),^{
        [weakSelf finishError:
          [NSString stringWithFormat:
            @"media_tracks_unavailable_d%lu_a%lu_v%lu_b%lu_h%ld_e%ld_r%d_x%d_t%d_c%d_n%lld",
            (unsigned long)downloadedCount,
            (unsigned long)audioOnlyCount,
            (unsigned long)videoOnlyCount,
            (unsigned long)combinedCount,
            (long)firstHTTPStatus,
            (long)firstErrorCode,
            firstResponseAccepted?1:0,
            firstExceeded?1:0,
            firstTimedOut?1:0,
            firstHadError?1:0,
            firstReceivedBytes]];
      });
      return;
    }

    NSMutableArray<NSString *> *limitations=[NSMutableArray array];
    if (audioPartial) [limitations addObject:@"bounded_audio_prefix"];
    if (videoPartial) [limitations addObject:@"bounded_video_prefix"];
    NSDictionary *result=@{
      @"version":@1,
      @"status":@"ok",
      @"mediaId":mediaId,
      @"canonicalUrl":pageURL,
      @"durationMs":@(durationMs),
      @"audio":@{
        @"relativePath":@"douyin-audio.m4a",
        @"byteSize":@(audioBytes),
        @"sha256":audioHash,
        @"detectedMime":@"audio/mp4",
        @"format":@"m4a",
        @"durationMs":@(durationMs)
      },
      @"video":@{
        @"relativePath":@"douyin-video.mp4",
        @"byteSize":@(videoBytes),
        @"sha256":videoHash,
        @"detectedMime":@"video/mp4",
        @"format":@"mp4",
        @"durationMs":@(durationMs),
        @"width":@(width),
        @"height":@(height)
      },
      @"limitations":limitations
    };
    dispatch_async(dispatch_get_main_queue(),^{
      [weakSelf finishSuccess:result];
    });
  });
}

- (void)finishSuccess:(NSDictionary *)result {
  if (self.finished) return;
  self.finished=YES;
  [self.webView stopLoading];
  [self.window close];
  Emit(result);
  gExitCode=0;
  CFRunLoopStop(CFRunLoopGetMain());
}

- (void)finishError:(NSString *)code {
  if (self.finished) return;
  self.finished=YES;
  [self.webView stopLoading];
  [self.window close];
  Emit(@{@"version":@1,@"status":@"error",@"code":code});
  gExitCode=69;
  CFRunLoopStop(CFRunLoopGetMain());
}
@end

int main(int argc,const char *argv[]) {
  @autoreleasepool {
    if (argc==2&&strcmp(argv[1],"--help")==0) {
      Emit(@{
        @"version":@1,
        @"status":@"help",
        @"contract":@"douyin_webkit_reader_v1"
      });
      return 0;
    }
    if (argc!=11) return ErrorResult(@"invalid_arguments",64);

    NSMutableDictionary<NSString *,NSString *> *arguments=
      [NSMutableDictionary dictionary];
    NSSet<NSString *> *allowed=[NSSet setWithArray:@[
      @"--url",
      @"--output-dir",
      @"--audio-max-bytes",
      @"--video-max-bytes",
      @"--deadline-ms"
    ]];
    for (int index=1;index<argc;index+=2) {
      NSString *name=[NSString stringWithUTF8String:argv[index]];
      NSString *value=[NSString stringWithUTF8String:argv[index+1]];
      if (name==nil||value==nil||
          ![allowed containsObject:name]||
          arguments[name]!=nil) {
        return ErrorResult(@"invalid_arguments",64);
      }
      arguments[name]=value;
    }
    if (arguments.count!=allowed.count) {
      return ErrorResult(@"invalid_arguments",64);
    }

    NSString *mediaId=nil;
    if (!CanonicalDouyinURL(arguments[@"--url"],&mediaId)) {
      return ErrorResult(@"invalid_url",64);
    }
    long long audioMax=0;
    long long videoMax=0;
    long long deadline=0;
    if (!ParseInteger(arguments[@"--audio-max-bytes"],&audioMax)||
        !ParseInteger(arguments[@"--video-max-bytes"],&videoMax)||
        !ParseInteger(arguments[@"--deadline-ms"],&deadline)||
        audioMax!=kAudioMaxBytes||
        videoMax!=kVideoMaxBytes||
        deadline<1000||deadline>120000) {
      return ErrorResult(@"invalid_arguments",64);
    }
    if (!PrivateOutputDirectory(arguments[@"--output-dir"])) {
      return ErrorResult(@"unsafe_output_directory",65);
    }

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    LLWDouyinReader *reader=[[LLWDouyinReader alloc]
      initWithURL:arguments[@"--url"]
      mediaId:mediaId
      outputDirectory:arguments[@"--output-dir"]
      deadlineMs:deadline
    ];
    [reader start];
    CFRunLoopRun();
    return gExitCode;
  }
}
