<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Event\FinishRequestEvent;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\Event\ResponseEvent;
use Symfony\Component\HttpKernel\KernelEvents;
use Throwable;
use WeakMap;

/** Automatic main-request span and unhandled-exception capture for Symfony. */
final class SymfonyRequestSubscriber implements EventSubscriberInterface
{
    /** @var WeakMap<Request, SymfonyRequestState> */
    private WeakMap $requests;

    public function __construct(private readonly SymfonyTelemetry $telemetry)
    {
        $this->requests = new WeakMap();
    }

    /** @return array<string, string|array{0:string,1:int}> */
    public static function getSubscribedEvents(): array
    {
        return [
            KernelEvents::REQUEST => ['onKernelRequest', -64],
            KernelEvents::EXCEPTION => ['onKernelException', 64],
            KernelEvents::RESPONSE => ['onKernelResponse', -1024],
            KernelEvents::FINISH_REQUEST => ['onKernelFinishRequest', -1024],
        ];
    }

    public function onKernelRequest(RequestEvent $event): void
    {
        if (!$event->isMainRequest()) {
            return;
        }

        $this->begin($event->getRequest());
    }

    public function onKernelException(ExceptionEvent $event): void
    {
        if (!$event->isMainRequest()) {
            return;
        }

        $request = $event->getRequest();
        $state = $this->requests[$request] ?? $this->begin($request);
        if ($state !== null) {
            $this->telemetry->recordException($state, $event->getThrowable());
        }
    }

    public function onKernelResponse(ResponseEvent $event): void
    {
        if (!$event->isMainRequest()) {
            return;
        }

        $request = $event->getRequest();
        $state = $this->requests[$request] ?? null;
        if ($state === null) {
            return;
        }

        try {
            $this->telemetry->finishRequest($state, $event->getResponse()->getStatusCode());
        } finally {
            unset($this->requests[$request]);
        }
    }

    public function onKernelFinishRequest(FinishRequestEvent $event): void
    {
        if (!$event->isMainRequest()) {
            return;
        }

        $request = $event->getRequest();
        $state = $this->requests[$request] ?? null;
        if ($state === null) {
            return;
        }

        try {
            $this->telemetry->cancelRequest($state);
        } finally {
            unset($this->requests[$request]);
        }
    }

    private function begin(Request $request): ?SymfonyRequestState
    {
        if (isset($this->requests[$request])) {
            return $this->requests[$request];
        }

        try {
            $state = $this->telemetry->beginRequest(
                $request->getMethod(),
                'symfony.route.' . self::routeName($request),
                $request->headers->get('traceparent')
            );
        } catch (Throwable) {
            return null;
        }

        if ($state !== null) {
            $this->requests[$request] = $state;
        }

        return $state;
    }

    private static function routeName(Request $request): string
    {
        $route = $request->attributes->get('_route');
        if (!is_string($route) || trim($route) === '') {
            return 'unmatched';
        }

        $normalized = preg_replace('/[^A-Za-z0-9_.:-]+/', '_', trim($route));
        if (!is_string($normalized) || $normalized === '') {
            return 'unmatched';
        }

        return substr($normalized, 0, 160);
    }
}
