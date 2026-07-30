#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreText/CoreText.h>
#import <ImageIO/ImageIO.h>
#import <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <math.h>
#include <sys/stat.h>
#include <unistd.h>

static const long long kMaxDurationMs=7LL*24LL*60LL*60LL*1000LL;
static const NSInteger kMaxSamples=192;
static const NSInteger kSamplesPerSheet=12;
static const size_t kSheetWidth=3200;
static const size_t kSheetHeight=1800;
static const size_t kCellWidth=800;
static const size_t kCellHeight=600;

static void WriteJSON(NSDictionary *value) {
  NSData *data=[NSJSONSerialization dataWithJSONObject:value
                                               options:0
                                                 error:nil];
  if (data!=nil) {
    fwrite(data.bytes,1,data.length,stdout);
    fputc('\n',stdout);
  }
}

static int Fail(NSString *code,int status) {
  WriteJSON(@{
    @"version":@1,
    @"status":@"error",
    @"code":code
  });
  return status;
}

static BOOL PrivateOwnedPath(NSString *path,BOOL directory) {
  struct stat info;
  if (lstat(path.fileSystemRepresentation,&info)!=0) return NO;
  if (S_ISLNK(info.st_mode)||info.st_uid!=getuid()||
      (info.st_mode&0077)!=0) {
    return NO;
  }
  return directory?S_ISDIR(info.st_mode):S_ISREG(info.st_mode);
}

static BOOL ParsePositiveInteger(NSString *value,long long *result) {
  if (value.length<1||value.length>20) return NO;
  errno=0;
  char *end=NULL;
  long long parsed=strtoll(value.UTF8String,&end,10);
  if (errno!=0||end==NULL||*end!='\0'||parsed<1) return NO;
  *result=parsed;
  return YES;
}

static NSString *SHA256File(NSString *path) {
  NSFileHandle *handle=[NSFileHandle fileHandleForReadingAtPath:path];
  if (handle==nil) return nil;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  @try {
    while (true) {
      @autoreleasepool {
        NSData *chunk=[handle readDataOfLength:1024*1024];
        if (chunk.length==0) break;
        CC_SHA256_Update(
          &context,
          chunk.bytes,
          (CC_LONG)chunk.length
        );
      }
    }
  } @catch (__unused NSException *exception) {
    [handle closeFile];
    return nil;
  }
  [handle closeFile];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest,&context);
  NSMutableString *hex=[
    NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH*2
  ];
  for (NSUInteger index=0;
       index<CC_SHA256_DIGEST_LENGTH;
       index++) {
    [hex appendFormat:@"%02x",digest[index]];
  }
  return hex;
}

static NSString *Timestamp(long long milliseconds) {
  long long totalSeconds=milliseconds/1000;
  long long hours=totalSeconds/3600;
  long long minutes=(totalSeconds%3600)/60;
  long long seconds=totalSeconds%60;
  if (hours>0) {
    return [NSString stringWithFormat:@"%02lld:%02lld:%02lld",
      hours,minutes,seconds];
  }
  return [NSString stringWithFormat:@"%02lld:%02lld",minutes,seconds];
}

static void DrawLabel(
  CGContextRef context,
  NSString *value,
  CGFloat x,
  CGFloat y
) {
  CTFontRef font=CTFontCreateWithName(CFSTR("Helvetica-Bold"),30,NULL);
  CGColorRef color=CGColorCreateGenericRGB(0.94,0.96,1.0,1.0);
  NSDictionary *attributes=@{
    (__bridge id)kCTFontAttributeName:(__bridge id)font,
    (__bridge id)kCTForegroundColorAttributeName:(__bridge id)color
  };
  NSAttributedString *text=[
    [NSAttributedString alloc] initWithString:value
                                   attributes:attributes
  ];
  CTLineRef line=CTLineCreateWithAttributedString(
    (__bridge CFAttributedStringRef)text
  );
  CGContextSetTextMatrix(context,CGAffineTransformIdentity);
  CGContextSetTextPosition(context,x,y);
  CTLineDraw(line,context);
  CFRelease(line);
  CGColorRelease(color);
  CFRelease(font);
}

static BOOL WriteSheet(
  NSString *path,
  NSArray *images,
  NSArray<NSDictionary *> *samples,
  NSInteger firstSample
) {
  size_t bytesPerRow=kSheetWidth*4;
  NSMutableData *pixels=[
    NSMutableData dataWithLength:bytesPerRow*kSheetHeight
  ];
  CGColorSpaceRef colorSpace=CGColorSpaceCreateDeviceRGB();
  CGContextRef context=CGBitmapContextCreate(
    pixels.mutableBytes,
    kSheetWidth,
    kSheetHeight,
    8,
    bytesPerRow,
    colorSpace,
    kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big
  );
  CGColorSpaceRelease(colorSpace);
  if (context==NULL) return NO;
  CGContextSetRGBFillColor(context,0.035,0.05,0.08,1.0);
  CGContextFillRect(
    context,
    CGRectMake(0,0,kSheetWidth,kSheetHeight)
  );

  for (NSInteger local=0;local<(NSInteger)images.count;local++) {
    CGImageRef image=(__bridge CGImageRef)images[local];
    NSInteger row=local/4;
    NSInteger column=local%4;
    CGFloat cellX=column*kCellWidth;
    CGFloat cellY=kSheetHeight-(row+1)*kCellHeight;
    CGContextSetRGBFillColor(context,0.08,0.10,0.14,1.0);
    CGContextFillRect(
      context,
      CGRectMake(cellX+8,cellY+8,kCellWidth-16,kCellHeight-16)
    );

    CGFloat sourceWidth=(CGFloat)CGImageGetWidth(image);
    CGFloat sourceHeight=(CGFloat)CGImageGetHeight(image);
    CGFloat scale=MIN(780.0/sourceWidth,510.0/sourceHeight);
    CGFloat drawWidth=floor(sourceWidth*scale);
    CGFloat drawHeight=floor(sourceHeight*scale);
    CGFloat drawX=cellX+(kCellWidth-drawWidth)/2.0;
    CGFloat drawY=cellY+70.0+(510.0-drawHeight)/2.0;
    CGContextDrawImage(
      context,
      CGRectMake(drawX,drawY,drawWidth,drawHeight),
      image
    );

    NSDictionary *sample=samples[firstSample+local];
    NSString *label=[NSString stringWithFormat:@"%@–%@",
      Timestamp([sample[@"startMs"] longLongValue]),
      Timestamp([sample[@"endMs"] longLongValue])
    ];
    DrawLabel(context,label,cellX+18,cellY+25);
  }

  CGImageRef sheet=CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  if (sheet==NULL) return NO;
  NSURL *url=[NSURL fileURLWithPath:path];
  CGImageDestinationRef destination=CGImageDestinationCreateWithURL(
    (__bridge CFURLRef)url,
    CFSTR("public.png"),
    1,
    NULL
  );
  if (destination==NULL) {
    CGImageRelease(sheet);
    return NO;
  }
  CGImageDestinationAddImage(destination,sheet,NULL);
  BOOL ok=CGImageDestinationFinalize(destination);
  CFRelease(destination);
  CGImageRelease(sheet);
  if (!ok) return NO;
  return chmod(path.fileSystemRepresentation,0600)==0;
}

static NSArray<NSDictionary *> *BuildSamples(
  long long durationMs,
  long long *maxGapMs
) {
  NSInteger sampleCount=(NSInteger)ceil((double)durationMs/5000.0);
  sampleCount=MAX(1,MIN(kMaxSamples,sampleCount));
  NSMutableArray *samples=[
    NSMutableArray arrayWithCapacity:(NSUInteger)sampleCount
  ];
  long long largest=0;
  for (NSInteger index=0;index<sampleCount;index++) {
    long long start=(durationMs*index)/sampleCount;
    long long end=(durationMs*(index+1))/sampleCount;
    if (end<=start) return nil;
    long long sample=start+(end-start)/2;
    [samples addObject:@{
      @"startMs":@(start),
      @"endMs":@(end),
      @"sampleMs":@(sample)
    }];
    largest=MAX(largest,end-start);
  }
  *maxGapMs=largest;
  return samples;
}

int main(int argc,const char *argv[]) {
  @autoreleasepool {
    if (argc!=7||
        strcmp(argv[1],"--video")!=0||
        strcmp(argv[3],"--output-dir")!=0||
        strcmp(argv[5],"--expected-duration-ms")!=0) {
      return Fail(@"invalid_arguments",64);
    }
    NSString *video=[NSString stringWithUTF8String:argv[2]];
    NSString *output=[NSString stringWithUTF8String:argv[4]];
    NSString *expectedValue=[NSString stringWithUTF8String:argv[6]];
    long long expectedDurationMs=0;
    if (video==nil||output==nil||expectedValue==nil||
        !video.isAbsolutePath||!output.isAbsolutePath||
        ![video.pathExtension.lowercaseString isEqualToString:@"mp4"]||
        !ParsePositiveInteger(expectedValue,&expectedDurationMs)||
        expectedDurationMs>kMaxDurationMs) {
      return Fail(@"invalid_arguments",64);
    }
    if (!PrivateOwnedPath(video,NO)||
        !PrivateOwnedPath(output,YES)) {
      return Fail(@"unsafe_input",65);
    }

    AVURLAsset *asset=[AVURLAsset URLAssetWithURL:
      [NSURL fileURLWithPath:video] options:@{
        AVURLAssetPreferPreciseDurationAndTimingKey:@YES
      }];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSArray<AVAssetTrack *> *videoTracks=[
      asset tracksWithMediaType:AVMediaTypeVideo
    ];
    double seconds=CMTimeGetSeconds(asset.duration);
#pragma clang diagnostic pop
    if (videoTracks.count<1||!isfinite(seconds)||seconds<=0) {
      return Fail(@"video_unreadable",66);
    }
    long long durationMs=llround(seconds*1000.0);
    if (durationMs<1||durationMs>kMaxDurationMs||
        llabs(durationMs-expectedDurationMs)>5000) {
      return Fail(@"duration_mismatch",66);
    }

    long long maxGapMs=0;
    NSArray<NSDictionary *> *samples=BuildSamples(
      durationMs,&maxGapMs
    );
    if (samples==nil||samples.count<1||
        samples.count>kMaxSamples) {
      return Fail(@"sampling_failed",66);
    }

    AVAssetImageGenerator *generator=[
      [AVAssetImageGenerator alloc] initWithAsset:asset
    ];
    generator.appliesPreferredTrackTransform=YES;
    generator.maximumSize=CGSizeMake(1920,1080);
    generator.requestedTimeToleranceBefore=CMTimeMake(1,4);
    generator.requestedTimeToleranceAfter=CMTimeMake(1,4);

    NSMutableArray<NSDictionary *> *sheets=[NSMutableArray array];
    NSMutableArray<NSString *> *created=[NSMutableArray array];
    NSInteger sheetCount=(samples.count+kSamplesPerSheet-1)/
      kSamplesPerSheet;
    for (NSInteger sheetIndex=0;sheetIndex<sheetCount;sheetIndex++) {
      NSInteger first=sheetIndex*kSamplesPerSheet;
      NSInteger last=MIN(
        first+kSamplesPerSheet-1,
        (NSInteger)samples.count-1
      );
      NSMutableArray *images=[
        NSMutableArray arrayWithCapacity:(NSUInteger)(last-first+1)
      ];
      BOOL generated=YES;
      for (NSInteger sampleIndex=first;
           sampleIndex<=last;
           sampleIndex++) {
        long long sampleMs=[
          samples[sampleIndex][@"sampleMs"] longLongValue
        ];
        NSError *error=nil;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        CGImageRef image=[generator copyCGImageAtTime:
          CMTimeMake(sampleMs,1000)
          actualTime:NULL
          error:&error
        ];
#pragma clang diagnostic pop
        if (image==NULL||error!=nil) {
          if (image!=NULL) CGImageRelease(image);
          generated=NO;
          break;
        }
        [images addObject:(__bridge id)image];
        CGImageRelease(image);
      }
      NSString *name=[NSString stringWithFormat:@"timeline-%03ld.png",
        (long)(sheetIndex+1)];
      NSString *path=[output stringByAppendingPathComponent:name];
      if (!generated||!WriteSheet(path,images,samples,first)) {
        for (NSString *createdPath in created) {
          [[NSFileManager defaultManager]
            removeItemAtPath:createdPath error:nil];
        }
        [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
        return Fail(@"frame_generation_failed",66);
      }
      [created addObject:path];
      NSString *hash=SHA256File(path);
      if (hash==nil) {
        for (NSString *createdPath in created) {
          [[NSFileManager defaultManager]
            removeItemAtPath:createdPath error:nil];
        }
        return Fail(@"frame_generation_failed",66);
      }
      [sheets addObject:@{
        @"relativePath":name,
        @"sha256":hash,
        @"width":@(kSheetWidth),
        @"height":@(kSheetHeight),
        @"startMs":samples[first][@"startMs"],
        @"endMs":samples[last][@"endMs"],
        @"firstSampleIndex":@(first),
        @"lastSampleIndex":@(last)
      }];
    }

    WriteJSON(@{
      @"version":@1,
      @"status":@"ok",
      @"contract":@"video_timeline_reader_v1",
      @"durationMs":@(durationMs),
      @"sampleCount":@(samples.count),
      @"maxGapMs":@(maxGapMs),
      @"samples":samples,
      @"sheets":sheets,
      @"limitations":@[
        @"uniform_timeline_sampling",
        @"not_frame_by_frame"
      ]
    });
    return 0;
  }
}
