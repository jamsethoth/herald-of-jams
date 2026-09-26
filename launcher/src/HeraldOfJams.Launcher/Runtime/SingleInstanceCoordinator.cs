using System.IO.Pipes;

namespace HeraldOfJams.Launcher.Runtime;

public sealed class SingleInstanceCoordinator : IAsyncDisposable
{
    private readonly string name;
    private readonly Func<Task> openAdministration;
    private readonly string pipeName;
    private readonly CancellationTokenSource cancellation = new();
    private readonly AutoResetEvent ownershipRequest = new(false);
    private readonly AutoResetEvent ownershipComplete = new(false);
    private readonly Thread ownershipThread;
    private Task? listener;
    private bool ownsMutex;
    private bool stopOwnership;

    public SingleInstanceCoordinator(string name, Func<Task> openAdministration)
    {
        this.name = name;
        this.openAdministration = openAdministration;
        pipeName = $"{name}-pipe";
        ownershipThread = new Thread(OwnMutex) { IsBackground = true, Name = "Herald of Jams instance ownership" };
        ownershipThread.Start();
    }

    public bool TryBecomePrimary()
    {
        if (ownsMutex) return true;
        ownershipRequest.Set();
        ownershipComplete.WaitOne();
        if (ownsMutex) listener = ListenAsync(cancellation.Token);
        return ownsMutex;
    }

    public async Task SignalOpenAdministrationAsync()
    {
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await client.ConnectAsync(timeout.Token);
        await client.WriteAsync(new byte[] { 1 }, timeout.Token);
        await client.FlushAsync(timeout.Token);
    }

    private async Task ListenAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(token);
                var buffer = new byte[1];
                if (await server.ReadAsync(buffer, token) == 1) await openAdministration();
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        }
    }

    public async ValueTask DisposeAsync()
    {
        cancellation.Cancel();
        if (listener is not null) await listener;
        stopOwnership = true;
        ownershipRequest.Set();
        ownershipThread.Join();
        ownershipRequest.Dispose();
        ownershipComplete.Dispose();
        cancellation.Dispose();
    }

    private void OwnMutex()
    {
        using var mutex = new Mutex(false, $"Local\\{name}");
        while (true)
        {
            ownershipRequest.WaitOne();
            if (stopOwnership)
            {
                if (ownsMutex) mutex.ReleaseMutex();
                return;
            }
            try { ownsMutex = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { ownsMutex = true; }
            ownershipComplete.Set();
        }
    }
}
