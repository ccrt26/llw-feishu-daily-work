#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <CoreVideo/CoreVideo.h>

static const int Width = 640;
static const int Height = 360;
static const int FrameRate = 10;
static const int DurationSeconds = 12;

static void DrawText(
    CGContextRef context,
    NSString *value,
    CGPoint point,
    CGFloat size,
    CGColorRef color
) {
    CTFontRef font = CTFontCreateWithName(CFSTR("Helvetica-Bold"), size, NULL);
    NSDictionary *attributes = @{
        (__bridge id)kCTFontAttributeName: (__bridge id)font,
        (__bridge id)kCTForegroundColorAttributeName: (__bridge id)color
    };
    NSAttributedString *text = [[NSAttributedString alloc]
        initWithString:value
        attributes:attributes
    ];
    CTLineRef line = CTLineCreateWithAttributedString(
        (__bridge CFAttributedStringRef)text
    );
    CGContextSetTextPosition(context, point.x, point.y);
    CTLineDraw(line, context);
    CFRelease(line);
    CFRelease(font);
}

static CVPixelBufferRef CreateFrame(
    CVPixelBufferPoolRef pool,
    double seconds
) {
    CVPixelBufferRef buffer = NULL;
    if (CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &buffer) !=
        kCVReturnSuccess) {
        return NULL;
    }
    CVPixelBufferLockBaseAddress(buffer, 0);
    void *base = CVPixelBufferGetBaseAddress(buffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(buffer);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(
        base,
        Width,
        Height,
        8,
        bytesPerRow,
        colorSpace,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Big
    );
    CGColorSpaceRelease(colorSpace);
    if (context == NULL) {
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        CVPixelBufferRelease(buffer);
        return NULL;
    }

    CGContextSetRGBFillColor(context, 0.04, 0.07, 0.12, 1.0);
    CGContextFillRect(context, CGRectMake(0, 0, Width, Height));

    NSString *shape = nil;
    if (seconds < 4.0) {
        shape = @"CIRCLE";
        CGContextSetRGBFillColor(context, 0.18, 0.66, 0.95, 1.0);
        CGContextFillEllipseInRect(context, CGRectMake(240, 100, 160, 160));
    } else if (seconds < 8.0) {
        shape = @"SQUARE";
        CGContextSetRGBFillColor(context, 0.96, 0.73, 0.18, 1.0);
        CGContextFillRect(context, CGRectMake(240, 100, 160, 160));
    } else {
        shape = @"TRIANGLE";
        CGContextSetRGBFillColor(context, 0.35, 0.82, 0.48, 1.0);
        CGContextBeginPath(context);
        CGContextMoveToPoint(context, 320, 270);
        CGContextAddLineToPoint(context, 220, 90);
        CGContextAddLineToPoint(context, 420, 90);
        CGContextClosePath(context);
        CGContextFillPath(context);
    }

    CGColorRef labelColor = CGColorCreateGenericGray(0.9, 1.0);
    DrawText(context, shape, CGPointMake(28, 310), 26, labelColor);
    CGColorRelease(labelColor);

    if (seconds >= 5.0 && seconds < 7.0) {
        CGFloat components[] = {0.25, 0.68, 1.0, 1.0};
        CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
        CGColorRef codeColor = CGColorCreate(rgb, components);
        CGColorSpaceRelease(rgb);
        DrawText(
            context,
            @"BLUE-7319",
            CGPointMake(205, 45),
            42,
            codeColor
        );
        CGColorRelease(codeColor);
    }

    CGContextRelease(context);
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    return buffer;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 2) {
            fprintf(stderr, "usage\n");
            return 2;
        }
        NSString *path = [NSString stringWithUTF8String:argv[1]];
        NSURL *output = [NSURL fileURLWithPath:path];
        NSError *error = nil;
        AVAssetWriter *writer = [[AVAssetWriter alloc]
            initWithURL:output
            fileType:AVFileTypeQuickTimeMovie
            error:&error
        ];
        if (writer == nil) {
            fprintf(stderr, "writer\n");
            return 3;
        }
        NSDictionary *settings = @{
            AVVideoCodecKey: AVVideoCodecTypeAppleProRes422,
            AVVideoWidthKey: @(Width),
            AVVideoHeightKey: @(Height)
        };
        AVAssetWriterInput *input = [AVAssetWriterInput
            assetWriterInputWithMediaType:AVMediaTypeVideo
            outputSettings:settings
        ];
        input.expectsMediaDataInRealTime = NO;
        NSDictionary *attributes = @{
            (NSString *)kCVPixelBufferPixelFormatTypeKey:
                @(kCVPixelFormatType_32ARGB),
            (NSString *)kCVPixelBufferWidthKey: @(Width),
            (NSString *)kCVPixelBufferHeightKey: @(Height)
        };
        AVAssetWriterInputPixelBufferAdaptor *adaptor =
            [AVAssetWriterInputPixelBufferAdaptor
                assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input
                sourcePixelBufferAttributes:attributes
            ];
        if (![writer canAddInput:input]) {
            fprintf(stderr, "input\n");
            return 4;
        }
        [writer addInput:input];
        if (![writer startWriting]) {
            fprintf(
                stderr,
                "start:%s\n",
                writer.error.localizedDescription.UTF8String ?: "unknown"
            );
            return 5;
        }
        [writer startSessionAtSourceTime:kCMTimeZero];

        for (int frame = 0; frame < DurationSeconds * FrameRate; frame++) {
            while (!input.readyForMoreMediaData) {
                usleep(1000);
            }
            double seconds = (double)frame / (double)FrameRate;
            CVPixelBufferRef buffer = CreateFrame(
                adaptor.pixelBufferPool,
                seconds
            );
            if (buffer == NULL) {
                fprintf(stderr, "frame\n");
                return 6;
            }
            CMTime time = CMTimeMake(frame, FrameRate);
            BOOL appended = [adaptor
                appendPixelBuffer:buffer
                withPresentationTime:time
            ];
            CVPixelBufferRelease(buffer);
            if (!appended) {
                fprintf(stderr, "append\n");
                return 7;
            }
        }

        [input markAsFinished];
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{
            dispatch_semaphore_signal(finished);
        }];
        dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
        if (writer.status != AVAssetWriterStatusCompleted) {
            fprintf(stderr, "finish\n");
            return 8;
        }
        return 0;
    }
}
