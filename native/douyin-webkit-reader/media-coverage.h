#ifndef LLW_DOUYIN_MEDIA_COVERAGE_H
#define LLW_DOUYIN_MEDIA_COVERAGE_H

typedef enum {
  LLWAudioObjectKeepPrefix=0,
  LLWAudioObjectCompletePresent=1,
  LLWAudioObjectFetchComplete=2
} LLWAudioObjectDecision;

LLWAudioObjectDecision LLWAudioObjectCoverageDecision(
  long long sourceTotalBytes,
  long long receivedBytes,
  long long maximumBytes
);

int LLWAudioDurationMatchesPlayer(
  long long audioDurationMs,
  long long playerDurationMs
);

#endif
