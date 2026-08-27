@_spi(CrashReplay) import LogBrew

func nativeCrashExceptionChain(for exception: IssueException) -> IssueExceptionChain {
    IssueExceptionChain(entries: [
        IssueExceptionChainEntry(
            id: 0,
            relationship: .reported,
            type: exception.type,
            messageState: .notCaptured,
            mechanism: exception.mechanism,
            stackFramesState: .notCaptured,
        ),
    ])
}
