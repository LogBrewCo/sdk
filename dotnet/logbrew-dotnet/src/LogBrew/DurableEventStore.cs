#if NET8_0_OR_GREATER
using System;
using System.IO;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace LogBrew
{
    internal sealed class DurableEventStore : IDurableDeliveryStore
    {
        private const string StateFileName = "delivery-state.lbd";
        private const byte EventRecordKind = 1;
        private const byte PrefixRecordKind = 2;
        private const byte AcknowledgedRecordKind = 3;
        private const byte RecordVersion = 1;
        private const int NonceBytes = 12;
        private const int TagBytes = 16;
        private const int MaximumRecordBytes = 512 * 1024;
        private static readonly byte[] RecordMagic = Encoding.ASCII.GetBytes("LBDOTN01");
        private readonly DurableStoreFileSystem fileSystem;
        private readonly string primaryKeyId;
        private readonly Dictionary<string, byte[]> keys;
        private readonly int maximumRecoveryEvents;
        private readonly long maximumRecoveryBytes;
        private long nextSequence = 1;
        private bool disposed;

        private DurableEventStore(
            DurableStoreFileSystem fileSystem,
            string primaryKeyId,
            Dictionary<string, byte[]> keys,
            int maximumRecoveryEvents,
            int maximumQueueBytes)
        {
            this.fileSystem = fileSystem;
            this.primaryKeyId = primaryKeyId;
            this.keys = keys;
            this.maximumRecoveryEvents = maximumRecoveryEvents;
            maximumRecoveryBytes = ComputeMaximumRecoveryBytes(maximumRecoveryEvents, maximumQueueBytes);
        }

        internal static DurableEventStore Open(
            DurableDeliveryOptions options,
            int maximumRecoveryEvents,
            int maximumQueueBytes)
        {
            DurablePlatformSupport.RequireCurrent();
            var primaryKeyId = options.PrimaryKeyId;
            var transferredKeys = options.TakeKeys();
            DurableStoreFileSystem? fileSystem = null;
            var storeOwnsResources = false;
            try
            {
                fileSystem = DurableStoreFileSystem.Open(options.ParentDirectory);
                var store = new DurableEventStore(
                    fileSystem,
                    primaryKeyId,
                    transferredKeys,
                    maximumRecoveryEvents,
                    maximumQueueBytes);
                store.ValidateOwnership();
                storeOwnsResources = true;
                return store;
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                if (error is SdkException)
                {
                    throw;
                }

                throw StorageUnavailable();
            }
            finally
            {
                if (!storeOwnsResources)
                {
                    fileSystem?.Dispose();
                    ZeroKeys(transferredKeys);
                }
            }
        }

        public void ValidateOwnership()
        {
            RequireNotDisposed();
            fileSystem.ValidateOwnership();
        }

        public DurableStoreSnapshot Load()
        {
            RequireNotDisposed();
            var persistedRecordCount = 0;
            long persistedBytes = 0;
            try
            {
                return LoadValid(ref persistedRecordCount, ref persistedBytes);
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                return new DurableStoreSnapshot(
                    Array.Empty<DurableStoredEvent>(),
                    null,
                    recoveryFailed: true,
                    persistedRecordCount,
                    persistedBytes);
            }
        }

        public string PersistEvent(Event item)
        {
            RequireNotDisposed();
            ValidateOwnership();
            var sequence = nextSequence;
            var recordName = "event-" + sequence.ToString("D20", CultureInfo.InvariantCulture) + ".lbd";
            var plaintext = DurableRecordCodec.SerializeEvent(item);
            try
            {
                WriteEncryptedRecord(recordName, EventRecordKind, sequence, plaintext, replace: false);
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("event_persisted");
#endif
                nextSequence = checked(sequence + 1);
                return recordName;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }

        public void PersistPrefix(string body, IReadOnlyList<string> recordNames)
        {
            RequireNotDisposed();
            ValidateRecordNames(recordNames);
            var plaintext = DurableRecordCodec.SerializePrefix(body, recordNames);
            try
            {
                WriteEncryptedRecord(StateFileName, PrefixRecordKind, 0, plaintext, replace: false);
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("prefix_persisted");
#endif
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }

        public void AcknowledgePrefix(IReadOnlyList<string> recordNames)
        {
            RequireNotDisposed();
            ValidateRecordNames(recordNames);
            var plaintext = DurableRecordCodec.SerializePrefix(string.Empty, recordNames);
            try
            {
                WriteEncryptedRecord(StateFileName, AcknowledgedRecordKind, 0, plaintext, replace: true);
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("acknowledgement_persisted");
#endif
                CleanupAcknowledged(recordNames);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }

        public void Purge()
        {
            RequireNotDisposed();
            fileSystem.Purge();
            nextSequence = 1;
            RetirePreviousKeys();
        }

        public void Dispose()
        {
            if (!disposed)
            {
                fileSystem.Dispose();
                foreach (var key in keys.Values)
                {
                    CryptographicOperations.ZeroMemory(key);
                }

                disposed = true;
            }
        }

        private DurableStoreSnapshot LoadValid(ref int persistedRecordCount, ref long persistedBytes)
        {
            ValidateOwnership();
            var eventRecords = new List<KeyValuePair<long, string>>();
            var hasState = false;
            foreach (var entry in fileSystem.EnumerateEntries(
                (long)maximumRecoveryEvents + 1,
                maximumRecoveryBytes))
            {
                persistedRecordCount = persistedRecordCount == int.MaxValue ? int.MaxValue : persistedRecordCount + 1;
                var name = entry.Name;
                var length = entry.Length;
                persistedBytes = length > long.MaxValue - persistedBytes ? long.MaxValue : persistedBytes + length;
                if (TryParseEventRecordName(name, out var sequence))
                {
                    if (eventRecords.Count == maximumRecoveryEvents)
                    {
                        throw StorageUnavailable();
                    }

                    eventRecords.Add(new KeyValuePair<long, string>(sequence, name));
                    continue;
                }

                if (string.Equals(name, StateFileName, StringComparison.Ordinal) && !hasState)
                {
                    hasState = true;
                    continue;
                }

                throw StorageUnavailable();
            }

            eventRecords.Sort((left, right) => left.Key.CompareTo(right.Key));
            var recovered = new List<DurableStoredEvent>(eventRecords.Count);
            long previousSequence = 0;
            foreach (var record in eventRecords)
            {
                if (record.Key <= previousSequence)
                {
                    throw StorageUnavailable();
                }

                var plaintext = ReadEncryptedRecord(record.Value, EventRecordKind, record.Key, out var keyId);
                try
                {
                    var item = DurableRecordCodec.DeserializeEvent(plaintext);
                    RotateRecordIfNeeded(record.Value, EventRecordKind, record.Key, keyId, plaintext);
                    recovered.Add(new DurableStoredEvent(item, record.Value, record.Key));
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(plaintext);
                }

                previousSequence = record.Key;
            }

            DurableStoredPrefix? prefix = null;
            if (hasState)
            {
                var state = ReadEncryptedStateRecord(out var stateKind, out var stateKeyId);
                try
                {
                    var storedPrefix = DurableRecordCodec.DeserializePrefix(state);
                    ValidateRecordNames(storedPrefix.RecordNames);
                    if (stateKind == AcknowledgedRecordKind)
                    {
                        CleanupAcknowledged(storedPrefix.RecordNames);
                        persistedRecordCount = 0;
                        persistedBytes = 0;
                        return LoadValid(ref persistedRecordCount, ref persistedBytes);
                    }

                    if (stateKind != PrefixRecordKind)
                    {
                        throw StorageUnavailable();
                    }

                    ValidatePrefix(recovered, storedPrefix);
                    RotateRecordIfNeeded(StateFileName, PrefixRecordKind, 0, stateKeyId, state);
                    prefix = storedPrefix;
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(state);
                }
            }

            nextSequence = previousSequence == 0 ? 1 : checked(previousSequence + 1);
            ValidateOwnership();
            RetirePreviousKeys();
            return new DurableStoreSnapshot(recovered, prefix, recoveryFailed: false, persistedRecordCount, persistedBytes);
        }

        private void WriteEncryptedRecord(string recordName, byte kind, long sequence, byte[] plaintext, bool replace)
        {
            var key = keys[primaryKeyId];
            var nonce = new byte[NonceBytes];
            var ciphertext = new byte[plaintext.Length];
            var tag = new byte[TagBytes];
            var keyIdBytes = Encoding.ASCII.GetBytes(primaryKeyId);
            var additionalData = Encoding.UTF8.GetBytes(
                "logbrew-dotnet-v1\n" + recordName + "\n" + kind.ToString(CultureInfo.InvariantCulture) + "\n" + sequence.ToString(CultureInfo.InvariantCulture) + "\n" + primaryKeyId);
            byte[]? record = null;
            try
            {
                RandomNumberGenerator.Fill(nonce);
                using (var cipher = new AesGcm(key, TagBytes))
                {
                    cipher.Encrypt(nonce, plaintext, ciphertext, tag, additionalData);
                }

                record = new byte[RecordMagic.Length + 1 + 1 + sizeof(long) + 1 + sizeof(int) + NonceBytes + keyIdBytes.Length + ciphertext.Length + TagBytes];
                using (var stream = new MemoryStream(record, writable: true))
                using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true))
                {
                    writer.Write(RecordMagic);
                    writer.Write(RecordVersion);
                    writer.Write(kind);
                    writer.Write(sequence);
                    writer.Write(checked((byte)keyIdBytes.Length));
                    writer.Write(ciphertext.Length);
                    writer.Write(nonce);
                    writer.Write(keyIdBytes);
                    writer.Write(ciphertext);
                    writer.Write(tag);
                }

                if (replace)
                {
                    fileSystem.Replace(recordName, record);
                }
                else
                {
                    fileSystem.Publish(recordName, record);
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(nonce);
                CryptographicOperations.ZeroMemory(ciphertext);
                CryptographicOperations.ZeroMemory(tag);
                CryptographicOperations.ZeroMemory(additionalData);
                if (record != null)
                {
                    CryptographicOperations.ZeroMemory(record);
                }
            }
        }

        private byte[] ReadEncryptedStateRecord(out byte kind, out string keyId)
        {
            var record = ReadRecordBytes(StateFileName);
            try
            {
                kind = ReadRecordKind(record);
                if (kind != PrefixRecordKind && kind != AcknowledgedRecordKind)
                {
                    throw StorageUnavailable();
                }

                return DecryptRecord(StateFileName, kind, 0, record, out keyId);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(record);
            }
        }

        private byte[] ReadEncryptedRecord(string recordName, byte expectedKind, long expectedSequence, out string keyId)
        {
            var record = ReadRecordBytes(recordName);
            try
            {
                return DecryptRecord(recordName, expectedKind, expectedSequence, record, out keyId);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(record);
            }
        }

        private byte[] DecryptRecord(
            string recordName,
            byte expectedKind,
            long expectedSequence,
            byte[] record,
            out string usedKeyId)
        {
            usedKeyId = string.Empty;
            using var stream = new MemoryStream(record, writable: false);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: true);
            var magic = reader.ReadBytes(RecordMagic.Length);
            if (!magic.SequenceEqual(RecordMagic)
                || reader.ReadByte() != RecordVersion
                || reader.ReadByte() != expectedKind
                || reader.ReadInt64() != expectedSequence)
            {
                throw StorageUnavailable();
            }

            var keyIdLength = reader.ReadByte();
            var ciphertextLength = reader.ReadInt32();
            if (keyIdLength == 0
                || keyIdLength > 64
                || ciphertextLength < 0
                || ciphertextLength > MaximumRecordBytes
                || record.Length != RecordMagic.Length + 1 + 1 + sizeof(long) + 1 + sizeof(int) + NonceBytes + keyIdLength + ciphertextLength + TagBytes)
            {
                throw StorageUnavailable();
            }

            var nonce = reader.ReadBytes(NonceBytes);
            var keyIdBytes = reader.ReadBytes(keyIdLength);
            var ciphertext = reader.ReadBytes(ciphertextLength);
            var tag = reader.ReadBytes(TagBytes);
            var plaintext = new byte[ciphertextLength];
            var additionalData = Array.Empty<byte>();
            try
            {
                var keyId = Encoding.ASCII.GetString(keyIdBytes);
                if (!keys.TryGetValue(keyId, out var key))
                {
                    throw StorageUnavailable();
                }

                usedKeyId = keyId;
                additionalData = Encoding.UTF8.GetBytes(
                    "logbrew-dotnet-v1\n" + recordName + "\n" + expectedKind.ToString(CultureInfo.InvariantCulture) + "\n" + expectedSequence.ToString(CultureInfo.InvariantCulture) + "\n" + keyId);
                using var cipher = new AesGcm(key, TagBytes);
                cipher.Decrypt(nonce, ciphertext, tag, plaintext, additionalData);
                return plaintext;
            }
            catch
            {
                CryptographicOperations.ZeroMemory(plaintext);
                throw;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(nonce);
                CryptographicOperations.ZeroMemory(keyIdBytes);
                CryptographicOperations.ZeroMemory(ciphertext);
                CryptographicOperations.ZeroMemory(tag);
                CryptographicOperations.ZeroMemory(additionalData);
            }
        }

        private void RotateRecordIfNeeded(
            string recordName,
            byte kind,
            long sequence,
            string keyId,
            byte[] plaintext)
        {
            if (string.Equals(keyId, primaryKeyId, StringComparison.Ordinal))
            {
                return;
            }

            WriteEncryptedRecord(recordName, kind, sequence, plaintext, replace: true);
#if LOGBREW_TEST_HOOKS
            DurableStoreTestHooks.Reach("rotation_record_persisted");
#endif
        }

        private void RetirePreviousKeys()
        {
            foreach (var keyId in keys.Keys.Where(keyId => !string.Equals(keyId, primaryKeyId, StringComparison.Ordinal)).ToList())
            {
                CryptographicOperations.ZeroMemory(keys[keyId]);
                keys.Remove(keyId);
            }
        }

        private byte[] ReadRecordBytes(string recordName)
        {
            return fileSystem.ReadRecord(recordName, MaximumRecordBytes);
        }

        private static byte ReadRecordKind(byte[] record)
        {
            var kindOffset = RecordMagic.Length + 1;
            if (record.Length <= kindOffset)
            {
                throw StorageUnavailable();
            }

            return record[kindOffset];
        }

        private void CleanupAcknowledged(IReadOnlyList<string> recordNames)
        {
            ValidateOwnership();
            foreach (var recordName in recordNames)
            {
                fileSystem.Delete(recordName, allowMissing: true);
            }

            fileSystem.Delete(StateFileName, allowMissing: false);
            fileSystem.FlushDirectory();
            ValidateOwnership();
        }

        private static bool TryParseEventRecordName(string name, out long sequence)
        {
            const string prefix = "event-";
            const string suffix = ".lbd";
            if (name.Length != prefix.Length + 20 + suffix.Length
                || !name.StartsWith(prefix, StringComparison.Ordinal)
                || !name.EndsWith(suffix, StringComparison.Ordinal))
            {
                sequence = 0;
                return false;
            }

            return long.TryParse(
                    name.AsSpan(prefix.Length, 20),
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out sequence)
                && sequence > 0;
        }

        private static void ValidateRecordNames(IReadOnlyList<string> recordNames)
        {
            if (recordNames.Count == 0 || recordNames.Count > DeliveryBatchBuilder.MaxRequestEvents)
            {
                throw StorageUnavailable();
            }

            long previousSequence = 0;
            foreach (var recordName in recordNames)
            {
                if (!TryParseEventRecordName(recordName, out var sequence) || sequence <= previousSequence)
                {
                    throw StorageUnavailable();
                }

                previousSequence = sequence;
            }
        }

        private static void ValidatePrefix(
            List<DurableStoredEvent> events,
            DurableStoredPrefix prefix)
        {
            if (prefix.RecordNames.Count > events.Count)
            {
                throw StorageUnavailable();
            }

            for (var index = 0; index < prefix.RecordNames.Count; index++)
            {
                if (!string.Equals(prefix.RecordNames[index], events[index].RecordName, StringComparison.Ordinal))
                {
                    throw StorageUnavailable();
                }
            }
        }

        private void RequireNotDisposed()
        {
            if (disposed)
            {
                throw StorageUnavailable();
            }
        }

        private static SdkException StorageUnavailable()
        {
            return new SdkException("storage_error", "durable delivery storage is unavailable");
        }

        private static void ZeroKeys(Dictionary<string, byte[]> ownedKeys)
        {
            foreach (var key in ownedKeys.Values)
            {
                CryptographicOperations.ZeroMemory(key);
            }
        }

        private static long ComputeMaximumRecoveryBytes(int maximumEvents, int maximumQueueBytes)
        {
            // Binary event records are bounded by twice the encoded queue plus fixed AEAD/name
            // overhead per event and one maximum-sized authenticated prefix record.
            var fixedOverhead = (256L * maximumEvents) + MaximumRecordBytes;
            var queueBytes = (long)maximumQueueBytes;
            return queueBytes > (long.MaxValue - fixedOverhead) / 2
                ? long.MaxValue
                : (2 * queueBytes) + fixedOverhead;
        }

    }

#if LOGBREW_TEST_HOOKS
    internal static class DurableStoreTestHooks
    {
        internal static Action<string>? Checkpoint { get; set; }

        internal static void Reach(string checkpoint)
        {
            Checkpoint?.Invoke(checkpoint);
        }
    }
#endif
}
#endif
