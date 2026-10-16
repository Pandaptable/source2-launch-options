// updater - Steam CDN downloader for Source 2 game binaries.
//
// Login modes:
//   (default)  anonymous - CS2 + Dota, no account needed
//   --login    password login: username + hidden password prompt, the
//              console authenticator handles Steam Guard; the refresh token
//              + account name are cached in updater.config and reused
//              silently on later runs (deadlock, CS2 tools depot)
//   --anonymous  force anonymous even when a saved login exists
//
// Depot discovery is cached per account+app in updater.config, so later runs
// go straight to the binary depots instead of walking every depot manifest.
// Only bin/win64/*.dll|exe and bin/linuxsteamrt/*.so are downloaded, minus a
// third-party exclusion list.
//
// Usage: dotnet run -c Release [-- <outputRoot> [--login|--anonymous]]
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using SteamKit2.Authentication;
using SteamKit2;

var argList = args.ToList();
var outputRoot = ".";
for (var i = 0; i < argList.Count; i++)
{
    if (!argList[i].StartsWith("--"))
    {
        outputRoot = argList[i];
        argList.RemoveAt(i);
        i--;
    }
}
var wantLogin = argList.Contains("--login");
var forceAnonymous = argList.Contains("--anonymous");
outputRoot = Path.GetFullPath(outputRoot);
Directory.CreateDirectory(outputRoot);

// (appid, name, binaries depot) for every Source 2 game we track.
var apps = new (uint AppId, string Name, uint DepotId)[]
{
    (730u, "cs2", 2347771u),
    (570u, "dota2", 373303u),
    (1422450u, "deadlock", 1422452u),
    (250820u, "steamvr", 250831u),
};

// Third-party runtimes the dumper has no use for; never download them.
var excludedPrefixes = new[]
{
    "qt5", "qt6", "sdl2", "sdl3", "openimagedenoise", "openvdb", "cri", "lgt", "vcruntime", "msvcp",
    "concrt", "dbghelp", "d3d", "dxgi", "nvapi", "amd", "amdxc", "nvngx", "nvcompiler", "nvcuda",
    "avcodec", "avformat", "avutil", "swscale", "swresample", "freetype", "harfbuzz", "libzip",
    "mysql", "ssl", "crypto", "zlib", "python3", "tbb", "embree", "oidn", "openal", "ak_",
};

var configPath = Path.Join(outputRoot, "updater.config");

var config = new Config();
try
{
    config = JsonSerializer.Deserialize<Config>(File.ReadAllText(configPath)) ?? new Config();
}
catch
{
    // no config yet
}

var steamClient = new SteamClient();
var manager = new CallbackManager(steamClient);
var cdn = new SteamKit2.CDN.Client(steamClient);

var steamUser = steamClient.GetHandler<SteamUser>();
Trace.Assert(steamUser is not null);

var steamApps = steamClient.GetHandler<SteamApps>();
Trace.Assert(steamApps is not null);

var steamContent = steamClient.GetHandler<SteamContent>();
Trace.Assert(steamContent is not null);

using var cancellationToken = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    Console.WriteLine("\n[Ctrl+C detected! Gracefully shutting down...]");
    eventArgs.Cancel = true;
    steamUser.LogOff();
    cancellationToken.Cancel();
};

var failures = 0;
var logonMode = "anonymous"; // anonymous | token | password
var savedDirty = false;

if (forceAnonymous)
{
    config.AccountName = null;
    config.RefreshToken = null;
}
else if (wantLogin)
{
    // force the password flow even if a token exists
    logonMode = "password";
}
else if (config.AccountName is not null && config.RefreshToken is not null)
{
    logonMode = "token";
}

var logonDetails = new SteamUser.LogOnDetails();

manager.Subscribe((SteamClient.ConnectedCallback cb) =>
{
    Console.WriteLine("Connected to Steam");
    switch (logonMode)
    {
        case "anonymous":
            steamUser.LogOnAnonymous();
            break;
        case "token":
            _ = TokenLogOn();
            break;
        case "password":
            _ = PasswordLogOn();
            break;
        case "reauth":
            // Reconnected after a token rejection; authenticate with the
            // saved credentials on this fresh connection.
            _ = PasswordLogOn(silent: true);
            break;
    }
});

async Task TokenLogOn()
{
    Console.WriteLine($"Logging on as {config.AccountName} (saved token)");
    logonDetails = new SteamUser.LogOnDetails
    {
        Username = config.AccountName,
        AccessToken = config.RefreshToken,
    };
    steamUser.LogOn(logonDetails);
}

async Task PasswordLogOn(bool silent = false)
{
    try
    {
        string? username;
        string? password;

        if (silent && config.AccountName is not null && config.Password is not null)
        {
            username = config.AccountName;
            password = config.Password;
        }
        else
        {
            Console.Write("username: ");
            username = Console.ReadLine();
            if (string.IsNullOrWhiteSpace(username))
            {
                Console.WriteLine("No username given");
                Interlocked.Increment(ref failures);
                cancellationToken.Cancel();
                return;
            }
            password = ReadPassword("password");
        }

        // The console authenticator prompts for device confirmations and
        // email/2FA codes on its own; remembered GuardData skips the email
        // code on later logins.
        var session = await steamClient.Authentication.BeginAuthSessionViaCredentialsAsync(new AuthSessionDetails
        {
            Username = username,
            Password = password,
            GuardData = config.GuardData,
            Authenticator = new UserConsoleAuthenticator(),
            DeviceFriendlyName = "updater",
            IsPersistentSession = true,
        });

        var result = await session.PollingWaitForResultAsync(cancellationToken.Token);

        config.AccountName = result.AccountName;
        config.RefreshToken = result.RefreshToken;
        config.Password = password;
        if (result.NewGuardData is not null)
            config.GuardData = result.NewGuardData;
        SaveConfig();

        Console.WriteLine($"Authenticated as {result.AccountName}");

        // Log on with the fresh token.
        logonDetails = new SteamUser.LogOnDetails
        {
            Username = result.AccountName,
            AccessToken = result.RefreshToken,
        };
        steamUser.LogOn(logonDetails);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Authentication failed: {ex.Message}");
        Interlocked.Increment(ref failures);
        cancellationToken.Cancel();
    }
}


manager.Subscribe((SteamClient.DisconnectedCallback cb) =>
{
    if (!cb.UserInitiated)
        Console.WriteLine("Disconnected from Steam");
    // Don't kill the reauth flow's intentional disconnect/reconnect.
    if (logonMode != "reauth")
        cancellationToken.Cancel();
});

manager.Subscribe((SteamUser.LoggedOnCallback cb) =>
{
    _ = HandleLoggedOn(cb);
});

async Task HandleLoggedOn(SteamUser.LoggedOnCallback cb)
{
    try
    {
        if (cb.Result == EResult.AccessDenied && logonMode == "token")
        {
            if (config.Password is not null)
            {
                // The client disconnects after a failed logon; reconnect
                // and re-authenticate on the fresh connection.
                Console.WriteLine("Token expired; reconnecting to re-authenticate");
                logonMode = "reauth";
                steamClient.Disconnect();
                steamClient.Connect();
            }
            else
            {
                Console.WriteLine("Token expired; run with --login");
                Interlocked.Increment(ref failures);
                cancellationToken.Cancel();
            }
            return;
        }

        if (cb.Result != EResult.OK)
        {
            Console.WriteLine($"Failed to log into Steam: {cb.Result} / {cb.ExtendedResult}");
            Interlocked.Increment(ref failures);
            cancellationToken.Cancel();
            return;
        }

        Console.WriteLine(logonMode == "anonymous" ? "Logged on anonymously" : $"Logged on as {logonDetails.Username}");

        var servers = await GetContentServers();
        Trace.Assert(servers.Count() > 0);

        foreach (var (appId, name, depotID) in apps)
        {
            try
            {
                await FetchAppBinaries(appId, name, depotID, servers, cancellationToken.Token);
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref failures);
                Console.WriteLine($"[!] {name} ({appId}) failed: {ex.Message}");
            }
        }

        steamUser.LogOff();
    }
    catch (OperationCanceledException)
    {
        steamUser.LogOff();
    }
}

void SaveConfig()
{
    File.WriteAllText(configPath, JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }));
    savedDirty = false;
}

async Task FetchAppBinaries(uint appId, string appName, uint depotID, IEnumerable<SteamKit2.CDN.Server> servers, CancellationToken ct)
{
    ct.ThrowIfCancellationRequested();

    Console.WriteLine();
    Console.WriteLine($"===== {appName} (app {appId}, depot {depotID}) =====");

    // The app's product info carries the depot's current public manifest.
    // Private apps (deadlock) need their PICS access token or appinfo comes
    // back empty.
    var tokens = await steamApps.PICSGetAccessTokens([appId], new List<uint>());
    tokens.AppTokens.TryGetValue(appId, out var appToken);
    var request = appToken != 0
        ? new SteamApps.PICSRequest(appId, appToken)
        : new SteamApps.PICSRequest(appId);
    var products = await steamApps.PICSGetProductInfo(request, null);
    Trace.Assert(!products.Failed);
    ct.ThrowIfCancellationRequested();

    var result = products.Results?.FirstOrDefault(x => x.Apps.ContainsKey(appId))?.Apps.GetValueOrDefault<uint, SteamApps.PICSProductInfoCallback.PICSProductInfo>(appId);
    Trace.Assert(result is not null);

    var manifestID = result.KeyValues["depots"]?[depotID.ToString()]?["manifests"]?["public"]?["gid"]?.AsUnsignedLong() ?? 0;
    var buildIdNode = result.KeyValues["depots"]?[depotID.ToString()]?["buildid"];
    if (string.IsNullOrEmpty(buildIdNode?.Value))
        buildIdNode = result.KeyValues["depots"]?["branches"]?["public"]?["buildid"];
    _ = ulong.TryParse(buildIdNode?.Value, out var buildId);
    // Record build metadata for the commit-message generator.
    config.Builds[appName] = new BuildInfo
    {
        AppId = appId,
        DepotId = depotID,
        BuildId = buildId,
        ManifestId = manifestID,
    };
    SaveConfig();

    if (manifestID == 0)
    {
        Console.WriteLine($"[skip] no public manifest for depot {depotID} visible to this account");
        return;
    }

    var manifestRequestCode = await steamContent.GetManifestRequestCode(depotID, appId, manifestID);
    ct.ThrowIfCancellationRequested();
    if (manifestRequestCode == 0)
    {
        Console.WriteLine($"[skip] depot {depotID}: manifest request denied (needs ownership?)");
        return;
    }

    var server = servers.OrderBy(x => Random.Shared.Next()).FirstOrDefault();
    Trace.Assert(server is not null);

    DepotManifest manifest;
    try
    {
        Console.WriteLine($"Downloading manifest {manifestID}");
        manifest = await cdn.DownloadManifestAsync(depotID, manifestID, manifestRequestCode, server);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[skip] manifest download failed: {ex.Message}");
        return;
    }

    var depotKey = await steamApps.GetDepotDecryptionKey(depotID, appId);
    if (depotKey.Result != EResult.OK)
    {
        Console.WriteLine($"[skip] depot key denied ({depotKey.Result})");
        return;
    }
    ct.ThrowIfCancellationRequested();

    Trace.Assert(manifest.DecryptFilenames(depotKey.DepotKey));

    var wanted = manifest.Files?
        .Where(f => !f.Flags.HasFlag(EDepotFileFlag.Directory))
        .Where(f => IsWantedModule(f.FileName))
        .ToList() ?? [];

    Console.WriteLine($"depot {depotID}: {wanted.Count} module binaries");

    var appRoot = Path.Join(outputRoot, appName);
    Directory.CreateDirectory(appRoot);

    foreach (var file in wanted)
    {
        ct.ThrowIfCancellationRequested();
        await DownloadFileAsync(
            manifest,
            servers,
            depotKey.DepotKey,
            file,
            Path.Join(appRoot, file.FileName.Replace('/', Path.DirectorySeparatorChar)),
            cancellationToken: ct
        );
    }
}

bool IsWantedModule(string fileName)
{
    var normalized = fileName.Replace('\\', '/').ToLowerInvariant();
    if (!normalized.EndsWith(".dll") && !normalized.EndsWith(".exe") && !normalized.EndsWith(".so"))
        return false;
    if (!normalized.Contains("bin/win64/") && !normalized.Contains("bin/linuxsteamrt/"))
        return false;

    var baseName = Path.GetFileNameWithoutExtension(normalized);
    return !excludedPrefixes.Any(p => baseName.StartsWith(p));
}

async Task<IEnumerable<SteamKit2.CDN.Server>> GetContentServers()
{
    var servers = await steamContent.GetServersForSteamPipe(steamClient.CellID);
    return servers.Where(x => (x.Type == "CDN" || x.Type == "SteamCache"));
}

async Task DownloadFileAsync(
    DepotManifest manifest,
    IEnumerable<SteamKit2.CDN.Server> servers,
    byte[] depotKey,
    DepotManifest.FileData file,
    string outputFile,
    CancellationToken cancellationToken = default
)
{
    var server = servers.OrderBy(x => Random.Shared.Next()).FirstOrDefault();
    Trace.Assert(server is not null);

    var outputDirectory = Path.GetDirectoryName(outputFile);
    if (outputDirectory is not null)
        Directory.CreateDirectory(outputDirectory);

    using var stream = File.Open(outputFile, FileMode.OpenOrCreate, FileAccess.ReadWrite);

    // Whole-file SHA1 skip: unchanged binaries cost nothing on re-runs.
    var oldFileHash = await SHA1.HashDataAsync(stream, cancellationToken);
    if (oldFileHash.AsSpan().SequenceEqual(file.FileHash))
        return;

    Console.WriteLine($"  {file.FileName} ({file.TotalSize} bytes)");

    using var semaphore = new SemaphoreSlim(1, 1);
    var validatedChunks = 0;
    var downloadedChunks = 0;

    await Parallel.ForEachAsync(
        file.Chunks,
        new ParallelOptions
        {
            MaxDegreeOfParallelism = 16,
            CancellationToken = cancellationToken,
        },
        async (chunk, ct) =>
        {
            ct.ThrowIfCancellationRequested();

            await semaphore.WaitAsync(ct);
            try
            {
                if (stream.Length > (long)chunk.Offset + chunk.UncompressedLength)
                {
                    stream.Position = (long)chunk.Offset;

                    var toCheck = new byte[chunk.UncompressedLength];
                    await stream.ReadExactlyAsync(toCheck, ct);

                    if (ChecksumDepotChunk(toCheck) == chunk.Checksum)
                    {
                        Interlocked.Increment(ref validatedChunks);
                        return;
                    }
                }
            }
            finally
            {
                semaphore.Release();
            }

            Trace.Assert(chunk.ChunkID is not null);

            var data = new byte[chunk.UncompressedLength];
            var size = await cdn.DownloadDepotChunkAsync(manifest.DepotID, chunk, server, data, depotKey);
            Trace.Assert(data.Length == size);

            var checksum = ChecksumDepotChunk(data);
            Trace.Assert(checksum == chunk.Checksum);

            await semaphore.WaitAsync(ct);
            try
            {
                stream.Position = (long)chunk.Offset;
                await stream.WriteAsync(data, ct);
            }
            finally
            {
                semaphore.Release();
            }

            Interlocked.Increment(ref downloadedChunks);
        }
    );

    stream.Position = 0;
    var fileHash = await SHA1.HashDataAsync(stream, cancellationToken);
    Trace.Assert(fileHash.AsSpan().SequenceEqual(file.FileHash));

    Console.WriteLine($"    updated (validated={validatedChunks} downloaded={downloadedChunks})");
}


static string ReadPassword(string prompt)
{
    Console.Write($"{prompt}: ");
    var chars = new List<char>();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter)
            break;
        if (key.Key == ConsoleKey.Backspace)
        {
            if (chars.Count > 0)
            {
                chars.RemoveAt(chars.Count - 1);
                Console.Write("\b \b");
            }
        }
        else if (!char.IsControl(key.KeyChar))
        {
            chars.Add(key.KeyChar);
            Console.Write('*');
        }
    }
    Console.WriteLine();
    return new string(chars.ToArray());
}
static uint ChecksumDepotChunk(ReadOnlySpan<byte> data)
{
    const uint ModAdler = 65521;

    uint s1 = 0;
    uint s2 = 0;
    while (data.Length > 0)
    {
        int chunkLength = Math.Min(data.Length, 5552);
        ReadOnlySpan<byte> chunk = data.Slice(0, chunkLength);
        data = data.Slice(chunkLength);

        for (int i = 0; i < chunk.Length; i++)
        {
            s1 += chunk[i];
            s2 += s1;
        }

        s1 %= ModAdler;
        s2 %= ModAdler;
    }

    return (s2 << 16) | s1;
}
Console.WriteLine($"Connecting to Steam... (output root: {outputRoot})");
steamClient.Connect();

while (!cancellationToken.IsCancellationRequested)
{
    try
    {
        await manager.RunWaitCallbackAsync(cancellationToken.Token);
    }
    catch (OperationCanceledException)
    {
        break;
    }
}

return failures == 0 ? 0 : 1;

class Config
{
    public string? AccountName { get; set; }
    public string? RefreshToken { get; set; }
    public string? GuardData { get; set; }
    public string? Password { get; set; }
    public Dictionary<string, BuildInfo> Builds { get; set; } = [];
}

class BuildInfo
{
    public uint AppId { get; set; }
    public uint DepotId { get; set; }
    public ulong BuildId { get; set; }
    public ulong ManifestId { get; set; }
}
