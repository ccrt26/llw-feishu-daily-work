#include <stdio.h>
#include "../../native/douyin-webkit-reader/media-coverage.h"

int main(void) {
  const long long mib=1024LL*1024LL;
  printf(
    "%d,%d,%d,%d,%d\n",
    LLWAudioObjectCoverageDecision(0,8*mib,32*mib),
    LLWAudioObjectCoverageDecision(40*mib,8*mib,32*mib),
    LLWAudioObjectCoverageDecision(8*mib,8*mib,32*mib),
    LLWAudioObjectCoverageDecision(9*mib,8*mib,32*mib),
    LLWAudioObjectCoverageDecision(7*mib,8*mib,32*mib)
  );
  printf(
    "%d,%d,%d,%d,%d\n",
    LLWAudioDurationMatchesPlayer(300000,300000),
    LLWAudioDurationMatchesPlayer(301999,300000),
    LLWAudioDurationMatchesPlayer(302001,300000),
    LLWAudioDurationMatchesPlayer(64689,3304600),
    LLWAudioDurationMatchesPlayer(0,300000)
  );
  return 0;
}
