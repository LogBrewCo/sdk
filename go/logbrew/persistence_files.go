package logbrew

var persistenceEnvelopeMagic = []byte{'L', 'B', 'G', 'O', 'P', '0', '0', '1'}

const (
	persistentLockFile   = ".owner.lock"
	persistentTempFile   = ".transaction.next"
	persistentIntentFile = ".transaction.intent"
)

type persistenceFailure func(point string) error

type persistentFiles interface {
	exists(name string) (bool, error)
	read(name string, maxBytes int64) ([]byte, error)
	atomicReplace(name string, data []byte, expected *[32]byte) error
	ownerMarker() ([]byte, error)
	freshBoundary() (bool, error)
	verifyBoundary() error
	validateLayout() error
	purge() error
	close() error
}
