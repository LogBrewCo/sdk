import Darwin
import Foundation

enum CrashStorageDirectory {
    static func normalized(_ url: URL) -> URL {
        let parent = url.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
        return parent.appendingPathComponent(url.lastPathComponent, isDirectory: true).standardizedFileURL
    }

    static func prepare(_ url: URL) throws -> CrashStorageLease {
        let path = url.path
        var info = stat()
        if lstat(path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFDIR,
                  info.st_mode & S_IFMT != S_IFLNK
            else {
                throw NativeCrashError(.storageUnsupported)
            }
        } else if errno == ENOENT {
            do {
                try FileManager.default.createDirectory(
                    at: url,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: NSNumber(value: 0o700)],
                )
            } catch {
                throw NativeCrashError(.storageUnsupported)
            }
        } else {
            throw NativeCrashError(.storageUnsupported)
        }

        let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw NativeCrashError(.storageUnsupported)
        }
        var opened = stat()
        guard fchmod(descriptor, S_IRWXU) == 0,
              fstat(descriptor, &opened) == 0,
              lstat(path, &info) == 0,
              opened.st_mode & S_IFMT == S_IFDIR,
              opened.st_mode & 0o077 == 0,
              opened.st_dev == info.st_dev,
              opened.st_ino == info.st_ino
        else {
            close(descriptor)
            throw NativeCrashError(.storageUnsupported)
        }
        return CrashStorageLease(
            descriptor: descriptor,
            path: path,
            device: opened.st_dev,
            inode: opened.st_ino,
        )
    }
}

final class CrashStorageLease: @unchecked Sendable {
    private let descriptor: Int32
    private let path: String
    private let device: dev_t
    private let inode: ino_t

    init(descriptor: Int32, path: String, device: dev_t, inode: ino_t) {
        self.descriptor = descriptor
        self.path = path
        self.device = device
        self.inode = inode
    }

    deinit {
        close(descriptor)
    }

    func verify() throws {
        var opened = stat()
        var current = stat()
        guard fstat(descriptor, &opened) == 0,
              lstat(path, &current) == 0,
              opened.st_mode & S_IFMT == S_IFDIR,
              opened.st_mode & 0o077 == 0,
              opened.st_dev == device,
              opened.st_ino == inode,
              current.st_dev == device,
              current.st_ino == inode
        else {
            throw NativeCrashError(.storageUnsupported)
        }
    }
}
