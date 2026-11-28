// The guard's answer in one word, read from the first line of a guardrail-mcp reply: "ACCEPTED", the refusing rule
// ("G1" ... "G10"), "CANCELLED", or "OTHER" for anything else (a failed call is never a refusal).
export function verdictOf(reply) {
  const first = String(reply).split("\n")[0];
  if (first.startsWith("ACCEPTED")) return "ACCEPTED";
  if (first.startsWith("CANCELLED")) return "CANCELLED";
  const refused = /^REFUSED by (G\d+) /.exec(first);
  return refused ? refused[1] : "OTHER";
}

/** True when the reply is the answer a step expects: "ACCEPTED", "CANCELLED" or a rule such as "G6". */
export const matches = (reply, expected) => verdictOf(reply) === expected;
