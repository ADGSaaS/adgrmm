// AdgRmm.Agent/Tray/TrayClient.cs
//
// The tray app's side of the pipe.
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace AdgRmm.Agent.Tray;

internal sealed class TrayClient
{
    private readonly string _pipe;
    public TrayClient(string? pipe = null) => _pipe = string.IsNullOrWhiteSpace(pipe) ? TrayProtocol.PipeName : pipe;

    /// <summary>Asks the agent. Never throws: a pipe that is not there (agent stopped, updating) is an answer of "not connected".</summary>
    public async Task<TrayProtocol.Response> CallAsync(TrayProtocol.Request req, CancellationToken ct = default)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(25));
            using var pipe = new NamedPipeClientStream(".", _pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(3000, cts.Token);
            var line = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(req, TrayProtocol.Json) + "\n");
            await pipe.WriteAsync(line, cts.Token);
            await pipe.FlushAsync(cts.Token);
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, leaveOpen: true);
            var answer = await reader.ReadLineAsync(cts.Token);
            if (string.IsNullOrEmpty(answer)) return new(false, 0, null, "The agent did not answer.");
            return JsonSerializer.Deserialize<TrayProtocol.Response>(answer, TrayProtocol.Json) ?? new(false, 0, null, "The agent's answer could not be read.");
        }
        catch (OperationCanceledException) { return new(false, 0, null, "The agent did not answer in time."); }
        catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException) { return new(false, 0, null, "Not connected to the agent."); }
        catch (Exception e) { return new(false, 0, null, e.Message); }
    }
}
