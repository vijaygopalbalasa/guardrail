# Demo agent

A scripted trading agent that trades only through `guardrail-mcp` over stdio, the same way any agent framework
would. Run against a local validator:

```bash
scripts/local-validator.sh start
node demo/setup.mjs            # owner side: Velocity account, guard with the demo limits, a fresh agent key
node demo/agent.mjs runaway    # the planted loop: averages down a losing long, doubling the size every step
node demo/setup.mjs && node demo/agent.mjs calm   # a calm agent on a fresh guard: never refused
```

The strategy is one function, `decide(state) -> action`, in `agent.mjs`. A language model can replace it without
changing the MCP loop.
