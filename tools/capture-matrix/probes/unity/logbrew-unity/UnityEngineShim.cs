namespace UnityEngine;

public enum LogType
{
    Error,
    Assert,
    Warning,
    Log,
    Exception,
}

public static class Application
{
    public delegate void LogCallback(string condition, string stackTrace, LogType type);

    public static event LogCallback? logMessageReceived;

    internal static void Emit(string condition, LogType type) =>
        logMessageReceived?.Invoke(condition, Environment.StackTrace, type);
}

public static class Debug
{
    public static void Log(string message) => Application.Emit(message, LogType.Log);

    public static void LogWarning(string message) => Application.Emit(message, LogType.Warning);
}
