#if NET8_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace LogBrew
{
    internal static class DurableRecordCodec
    {
        private const int MaximumFields = 4096;
        private const int MaximumArrayItems = 4096;
        private const int MaximumDepth = 8;
        private const int MaximumStringBytes = 256 * 1024;
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        internal static byte[] SerializeEvent(Event item)
        {
            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, StrictUtf8, leaveOpen: true);
            WriteString(writer, item.Type);
            WriteString(writer, item.Timestamp);
            WriteString(writer, item.Id);
            WriteObject(writer, item.Attributes, 0);
            return stream.ToArray();
        }

        internal static Event DeserializeEvent(byte[] plaintext)
        {
            using var stream = new MemoryStream(plaintext, writable: false);
            using var reader = new BinaryReader(stream, StrictUtf8, leaveOpen: true);
            var item = new Event(
                ReadString(reader),
                ReadString(reader),
                ReadString(reader),
                ReadObject(reader, 0));
            RequireEnd(stream);
            return item;
        }

        internal static byte[] SerializePrefix(string body, IReadOnlyList<string> recordNames)
        {
            if (Encoding.UTF8.GetByteCount(body) > DeliveryBatchBuilder.MaxRequestBytes
                || recordNames.Count == 0
                || recordNames.Count > DeliveryBatchBuilder.MaxRequestEvents)
            {
                throw Corrupt();
            }

            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, StrictUtf8, leaveOpen: true);
            WriteString(writer, body);
            writer.Write(recordNames.Count);
            foreach (var recordName in recordNames)
            {
                WriteString(writer, recordName);
            }

            return stream.ToArray();
        }

        internal static DurableStoredPrefix DeserializePrefix(byte[] plaintext)
        {
            using var stream = new MemoryStream(plaintext, writable: false);
            using var reader = new BinaryReader(stream, StrictUtf8, leaveOpen: true);
            var body = ReadString(reader);
            if (Encoding.UTF8.GetByteCount(body) > DeliveryBatchBuilder.MaxRequestBytes)
            {
                throw Corrupt();
            }

            var count = reader.ReadInt32();
            if (count <= 0 || count > DeliveryBatchBuilder.MaxRequestEvents)
            {
                throw Corrupt();
            }

            var names = new List<string>(count);
            for (var index = 0; index < count; index++)
            {
                names.Add(ReadString(reader));
            }

            RequireEnd(stream);
            return new DurableStoredPrefix(body, names);
        }

        private static void WriteObject(BinaryWriter writer, OrderedJsonObject value, int depth)
        {
            if (depth > MaximumDepth || value.Values.Count > MaximumFields)
            {
                throw Corrupt();
            }

            writer.Write(value.Values.Count);
            foreach (var field in value.Values)
            {
                WriteString(writer, field.Key);
                WriteValue(writer, field.Value, depth + 1);
            }
        }

        private static OrderedJsonObject ReadObject(BinaryReader reader, int depth)
        {
            if (depth > MaximumDepth)
            {
                throw Corrupt();
            }

            var count = reader.ReadInt32();
            if (count < 0 || count > MaximumFields)
            {
                throw Corrupt();
            }

            var value = new OrderedJsonObject();
            for (var index = 0; index < count; index++)
            {
                value.Add(ReadString(reader), ReadValue(reader, depth + 1));
            }

            return value;
        }

        private static void WriteValue(BinaryWriter writer, object? value, int depth)
        {
            switch (value)
            {
                case null:
                    writer.Write((byte)0);
                    return;
                case string stringValue:
                    writer.Write((byte)1);
                    WriteString(writer, stringValue);
                    return;
                case bool booleanValue:
                    writer.Write(booleanValue ? (byte)3 : (byte)2);
                    return;
                case byte byteValue:
                    writer.Write((byte)4);
                    writer.Write(byteValue);
                    return;
                case short shortValue:
                    writer.Write((byte)5);
                    writer.Write(shortValue);
                    return;
                case int integerValue:
                    writer.Write((byte)6);
                    writer.Write(integerValue);
                    return;
                case long longValue:
                    writer.Write((byte)7);
                    writer.Write(longValue);
                    return;
                case float floatValue:
                    writer.Write((byte)8);
                    writer.Write(floatValue);
                    return;
                case double doubleValue:
                    writer.Write((byte)9);
                    writer.Write(doubleValue);
                    return;
                case decimal decimalValue:
                    writer.Write((byte)10);
                    foreach (var part in decimal.GetBits(decimalValue))
                    {
                        writer.Write(part);
                    }

                    return;
                case OrderedJsonObject objectValue:
                    writer.Write((byte)11);
                    WriteObject(writer, objectValue, depth);
                    return;
                case IEnumerable<OrderedJsonObject> objectValues:
                    writer.Write((byte)12);
                    WriteArray(writer, objectValues.Cast<object?>(), depth);
                    return;
                case IEnumerable<object?> values:
                    writer.Write((byte)12);
                    WriteArray(writer, values, depth);
                    return;
                default:
                    throw Corrupt();
            }
        }

        private static object? ReadValue(BinaryReader reader, int depth)
        {
            return reader.ReadByte() switch
            {
                0 => null,
                1 => ReadString(reader),
                2 => false,
                3 => true,
                4 => reader.ReadByte(),
                5 => reader.ReadInt16(),
                6 => reader.ReadInt32(),
                7 => reader.ReadInt64(),
                8 => ReadFiniteSingle(reader),
                9 => ReadFiniteDouble(reader),
                10 => new decimal(new[] { reader.ReadInt32(), reader.ReadInt32(), reader.ReadInt32(), reader.ReadInt32() }),
                11 => ReadObject(reader, depth),
                12 => ReadArray(reader, depth),
                _ => throw Corrupt(),
            };
        }

        private static void WriteArray(BinaryWriter writer, IEnumerable<object?> values, int depth)
        {
            if (depth > MaximumDepth)
            {
                throw Corrupt();
            }

            var items = new List<object?>();
            foreach (var value in values)
            {
                if (items.Count == MaximumArrayItems)
                {
                    throw Corrupt();
                }

                items.Add(value);
            }

            writer.Write(items.Count);
            foreach (var value in items)
            {
                WriteValue(writer, value, depth + 1);
            }
        }

        private static List<object?> ReadArray(BinaryReader reader, int depth)
        {
            if (depth > MaximumDepth)
            {
                throw Corrupt();
            }

            var count = reader.ReadInt32();
            if (count < 0 || count > MaximumArrayItems)
            {
                throw Corrupt();
            }

            var values = new List<object?>(count);
            for (var index = 0; index < count; index++)
            {
                values.Add(ReadValue(reader, depth + 1));
            }

            return values;
        }

        private static float ReadFiniteSingle(BinaryReader reader)
        {
            var value = reader.ReadSingle();
            return float.IsNaN(value) || float.IsInfinity(value) ? throw Corrupt() : value;
        }

        private static double ReadFiniteDouble(BinaryReader reader)
        {
            var value = reader.ReadDouble();
            return double.IsNaN(value) || double.IsInfinity(value) ? throw Corrupt() : value;
        }

        private static void WriteString(BinaryWriter writer, string value)
        {
            var bytes = StrictUtf8.GetBytes(value);
            try
            {
                if (bytes.Length > MaximumStringBytes)
                {
                    throw Corrupt();
                }

                writer.Write(bytes.Length);
                writer.Write(bytes);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(bytes);
            }
        }

        private static string ReadString(BinaryReader reader)
        {
            var length = reader.ReadInt32();
            if (length < 0 || length > MaximumStringBytes)
            {
                throw Corrupt();
            }

            var bytes = reader.ReadBytes(length);
            try
            {
                if (bytes.Length != length)
                {
                    throw Corrupt();
                }

                return StrictUtf8.GetString(bytes);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(bytes);
            }
        }

        private static void RequireEnd(Stream stream)
        {
            if (stream.Position != stream.Length)
            {
                throw Corrupt();
            }
        }

        private static SdkException Corrupt()
        {
            return new SdkException("storage_error", "durable delivery storage is unavailable");
        }
    }
}
#endif
