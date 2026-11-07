## mode: scoped

| scenario | passes | pass^1 | pass^10 | record ok | mean calls | mean input tok | failures |
|---|---|---|---|---|---|---|---|
| S11 Too expensive: moved to a cheaper plan that keeps what matters | 10/10 | 1.00 | 1 | 10/10 | 8.0 | 18801 |  |

pass^1 = 1.000   pass^10 = 1.000
tokens: 80 agent calls, 188011 input tokens (2350 per call), of which 103560 tool definitions (1295 per call, 55%)
case-record checks passed: 10/10
p50 cost to resolve: $0.1039 over 10 resolved of 10 runs (agent model only)

