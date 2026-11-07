## mode: scoped

| scenario | passes | pass^1 | pass^10 | record ok | mean calls | mean input tok | failures |
|---|---|---|---|---|---|---|---|
| S11 Too expensive: moved to a cheaper plan that keeps what matters | 10/10 | 1.00 | 1 | 10/10 | 9.0 | 19279 |  |

pass^1 = 1.000   pass^10 = 1.000
tokens: 90 agent calls, 192793 input tokens (2142 per call), of which 93340 tool definitions (1037 per call, 48%)
case-record checks passed: 10/10
p50 cost to resolve: $0.1074 over 10 resolved of 10 runs (agent model only)

