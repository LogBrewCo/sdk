<?php

declare(strict_types=1);

namespace LogBrew;

/**
 * @internal
 *
 * Commit one owner-only file and its directory entry before reporting success.
 */
final class DurableFileCommitter
{
    private function __construct()
    {
    }

    public static function commit(
        string $directory,
        string $fileName,
        string $payload,
        bool $replace
    ): void {
        $temporaryPath = $directory . '/.tmp-' . bin2hex(random_bytes(16));
        $handle = @fopen($temporaryPath, 'x+b');
        if (!is_resource($handle) || !@chmod($temporaryPath, 0600)) {
            if (is_resource($handle)) {
                @fclose($handle);
            }
            @unlink($temporaryPath);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }

        try {
            $offset = 0;
            while ($offset < strlen($payload)) {
                $written = @fwrite($handle, substr($payload, $offset));
                if (!is_int($written) || $written <= 0) {
                    throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
                }
                $offset += $written;
            }
            if (!@fflush($handle) || !@fsync($handle)) {
                throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
            }
            $temporaryStat = @fstat($handle);
            if (
                !is_array($temporaryStat)
                || ($temporaryStat['mode'] & 0170000) !== 0100000
                || ($temporaryStat['mode'] & 0777) !== 0600
                || (int) $temporaryStat['nlink'] !== 1
            ) {
                throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
            }
        } catch (\Throwable) {
            @fclose($handle);
            @unlink($temporaryPath);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }
        @fclose($handle);

        $targetPath = $directory . '/' . $fileName;
        if (!$replace) {
            self::publishWithoutReplacement(
                $directory,
                $temporaryPath,
                $targetPath,
                (int) $temporaryStat['dev'],
                (int) $temporaryStat['ino']
            );
            return;
        }
        if (!@rename($temporaryPath, $targetPath)) {
            @unlink($temporaryPath);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }
        if (self::syncDirectory($directory)) {
            return;
        }

        throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
    }

    private static function publishWithoutReplacement(
        string $directory,
        string $temporaryPath,
        string $targetPath,
        int $device,
        int $inode
    ): void {
        if (!@link($temporaryPath, $targetPath)) {
            @unlink($temporaryPath);
            if (is_array(@lstat($targetPath))) {
                throw new SdkError('persistent_queue_error', 'persistent event sequence already exists');
            }
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }

        if (!@unlink($temporaryPath)) {
            self::unlinkMatchingFile($targetPath, $device, $inode);
            self::unlinkMatchingFile($temporaryPath, $device, $inode);
            self::syncDirectory($directory);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }

        clearstatcache(true, $targetPath);
        $targetStat = @lstat($targetPath);
        if (
            !is_array($targetStat)
            || ($targetStat['mode'] & 0170000) !== 0100000
            || ($targetStat['mode'] & 0777) !== 0600
            || (int) $targetStat['nlink'] !== 1
            || (int) $targetStat['dev'] !== $device
            || (int) $targetStat['ino'] !== $inode
            || (function_exists('posix_geteuid') && (int) $targetStat['uid'] !== posix_geteuid())
        ) {
            self::unlinkMatchingFile($targetPath, $device, $inode);
            self::syncDirectory($directory);
            throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
        }

        if (self::syncDirectory($directory)) {
            return;
        }

        if (self::unlinkMatchingFile($targetPath, $device, $inode)) {
            self::syncDirectory($directory);
        }
        throw new SdkError('persistence_commit_error', 'persistent event durability is unconfirmed');
    }

    private static function unlinkMatchingFile(string $path, int $device, int $inode): bool
    {
        clearstatcache(true, $path);
        $stat = @lstat($path);
        return is_array($stat)
            && (int) $stat['dev'] === $device
            && (int) $stat['ino'] === $inode
            && @unlink($path);
    }

    private static function syncDirectory(string $directory): bool
    {
        $handle = @fopen($directory, 'rb');
        if (!is_resource($handle)) {
            return false;
        }
        try {
            return @fsync($handle);
        } finally {
            @fclose($handle);
        }
    }
}
