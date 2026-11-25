// Run through backend/test/session-signature.cjs, which writes the vectors file.
// One verifier handles every vector in order, as one running agent would.

using System.Text.Json;
using RemoteIQ.Agent.Shared;

using var doc = JsonDocument.Parse(File.ReadAllBytes(args[0]));
var verifier = new SessionStartVerifier();
var failures = 0;
var count = 0;

foreach (var v in doc.RootElement.EnumerateArray())
{
    count++;
    var name = v.GetProperty("name").GetString();
    var expect = v.GetProperty("expect").GetString()!;

    var opened = verifier.Open(
        v.GetProperty("message"),
        v.GetProperty("publicKeyPem").GetString(),
        v.GetProperty("agentId").GetString(),
        v.GetProperty("kind").GetString()!,
        v.GetProperty("sessionId").GetString()!,
        out var reason);

    var ok = expect == "ok"
        ? opened is not null && reason.Length == 0
        : opened is null && reason.Contains(expect, StringComparison.OrdinalIgnoreCase);

    if (ok && opened is not null && v.TryGetProperty("expectField", out var fields))
    {
        foreach (var field in fields.EnumerateObject())
        {
            var actual = opened.Value.TryGetProperty(field.Name, out var el) ? el.ToString() : null;
            if (actual != field.Value.GetString()) ok = false;
        }
    }

    Console.WriteLine($"{(ok ? "pass" : "FAIL")}  {name}{(ok ? "" : $" (expected '{expect}', got '{reason}')")}");
    if (!ok) failures++;
}

Console.WriteLine($"{count - failures} of {count} session start vectors behaved as expected.");
return failures == 0 ? 0 : 1;
