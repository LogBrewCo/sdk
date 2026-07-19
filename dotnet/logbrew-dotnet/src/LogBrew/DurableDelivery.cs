#if NET8_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace LogBrew
{
    public sealed class DurableDeliveryKey : IDisposable
    {
        private static readonly Regex IdentifierPattern = new Regex("\\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\z", RegexOptions.CultureInvariant);
        private readonly byte[] keyBytes;
        private bool disposed;

        public DurableDeliveryKey(string id, byte[] keyBytes)
        {
            if (string.IsNullOrEmpty(id) || !IdentifierPattern.IsMatch(id))
            {
                throw new SdkException("validation_error", "durable key id is invalid");
            }

            if (keyBytes == null || keyBytes.Length != 32)
            {
                throw new SdkException("validation_error", "durable key must contain exactly 32 bytes");
            }

            Id = id;
            this.keyBytes = (byte[])keyBytes.Clone();
        }

        public string Id { get; }

        internal byte[] TakeKeyBytes()
        {
            if (disposed)
            {
                throw new SdkException("configuration_error", "durable key is disposed");
            }

            disposed = true;
            return keyBytes;
        }

        public void Dispose()
        {
            if (!disposed)
            {
                CryptographicOperations.ZeroMemory(keyBytes);
                disposed = true;
            }
        }
    }

    public sealed class DurableDeliveryOptions : IDisposable
    {
        private const int MaximumPreviousKeys = 8;
        private Dictionary<string, byte[]> keys;
        private bool disposed;
        private bool transferred;

        public DurableDeliveryOptions(
            string parentDirectory,
            DurableDeliveryKey primaryKey,
            IEnumerable<DurableDeliveryKey>? previousKeys = null)
        {
            if (string.IsNullOrWhiteSpace(parentDirectory))
            {
                throw new SdkException("validation_error", "durable parent directory must be non-empty");
            }

            if (primaryKey == null)
            {
                throw new SdkException("validation_error", "durable primary key must be non-null");
            }

            string normalizedParent;
            try
            {
                normalizedParent = Path.GetFullPath(parentDirectory);
            }
            catch (Exception error) when (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
            {
                throw new SdkException("validation_error", "durable parent directory is invalid");
            }

            var previous = new List<DurableDeliveryKey>();
            foreach (var item in previousKeys ?? Array.Empty<DurableDeliveryKey>())
            {
                if (item == null || previous.Count == MaximumPreviousKeys)
                {
                    throw new SdkException("validation_error", "durable previous keys are invalid");
                }

                previous.Add(item);
            }

            var copied = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            try
            {
                copied.Add(primaryKey.Id, primaryKey.TakeKeyBytes());
                foreach (var item in previous)
                {
                    if (copied.ContainsKey(item.Id))
                    {
                        throw new SdkException("validation_error", "durable key ids must be unique");
                    }

                    copied.Add(item.Id, item.TakeKeyBytes());
                }
            }
            catch
            {
                foreach (var key in copied.Values)
                {
                    CryptographicOperations.ZeroMemory(key);
                }

                throw;
            }

            ParentDirectory = normalizedParent;
            PrimaryKeyId = primaryKey.Id;
            PreviousKeyIds = new ReadOnlyCollection<string>(previous.Select(item => item.Id).ToList());
            keys = copied;
        }

        public string PrimaryKeyId { get; }

        public IReadOnlyList<string> PreviousKeyIds { get; }

        internal string ParentDirectory { get; }

        internal Dictionary<string, byte[]> TakeKeys()
        {
            if (disposed || transferred)
            {
                throw new SdkException("configuration_error", "durable delivery options are disposed");
            }

            var owned = keys;
            keys = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            transferred = true;
            return owned;
        }

        public void Dispose()
        {
            if (!disposed)
            {
                if (!transferred)
                {
                    foreach (var key in keys.Values)
                    {
                        CryptographicOperations.ZeroMemory(key);
                    }
                }

                disposed = true;
            }
        }
    }
}
#endif
