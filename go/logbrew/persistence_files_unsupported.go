//go:build !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd

package logbrew

func openPersistentFiles(string, persistenceFailure, bool) (persistentFiles, error) {
	return nil, persistenceSDKError("persistence_unsupported")
}
