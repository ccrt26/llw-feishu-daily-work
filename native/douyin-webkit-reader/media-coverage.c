#include "media-coverage.h"

LLWAudioObjectDecision LLWAudioObjectCoverageDecision(
  long long sourceTotalBytes,
  long long receivedBytes,
  long long maximumBytes
) {
  if (
    sourceTotalBytes<1||
    receivedBytes<1||
    maximumBytes<1||
    sourceTotalBytes>maximumBytes||
    receivedBytes>sourceTotalBytes
  ) {
    return LLWAudioObjectKeepPrefix;
  }
  if (receivedBytes==sourceTotalBytes) {
    return LLWAudioObjectCompletePresent;
  }
  return LLWAudioObjectFetchComplete;
}

int LLWAudioDurationMatchesPlayer(
  long long audioDurationMs,
  long long playerDurationMs
) {
  if (audioDurationMs<1||playerDurationMs<1) return 0;
  long long difference=audioDurationMs-playerDurationMs;
  if (difference<0) difference=-difference;
  return difference<=2000;
}
