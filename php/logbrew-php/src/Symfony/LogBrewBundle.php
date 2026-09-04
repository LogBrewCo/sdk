<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use LogBrew\HttpTransport;
use Monolog\Handler\HandlerInterface;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Config\Definition\Configurator\DefinitionConfigurator;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\DependencyInjection\Definition;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use Symfony\Component\DependencyInjection\Reference;
use Symfony\Component\HttpKernel\Bundle\AbstractBundle;
use Symfony\Component\Messenger\Middleware\MiddlewareInterface;

/**
 * Native, optional Symfony integration for logbrew/sdk.
 *
 * @phpstan-type SymfonyBundleConfig array{
 *   enabled: bool,
 *   api_key: string|null,
 *   service: string,
 *   release: string,
 *   environment: string|null,
 *   endpoint: string,
 *   timeout: float,
 *   max_retries: int,
 *   level: 'debug'|'info'|'notice'|'warning'|'error'|'critical'|'alert'|'emergency',
 *   capture_requests: bool,
 *   capture_exceptions: bool,
 *   include_exception_message: bool,
 *   include_exception_trace: bool,
 *   context_provider: string|null
 * }
 */
final class LogBrewBundle extends AbstractBundle
{
    public function configure(DefinitionConfigurator $definition): void
    {
        $definition->rootNode()
            ->children()
                ->booleanNode('enabled')->defaultTrue()->end()
                ->scalarNode('api_key')->defaultNull()->end()
                ->scalarNode('service')->defaultValue('symfony-app')->cannotBeEmpty()->end()
                ->scalarNode('release')->defaultValue('unversioned')->cannotBeEmpty()->end()
                ->scalarNode('environment')->defaultNull()->end()
                ->scalarNode('endpoint')->defaultValue(HttpTransport::DEFAULT_ENDPOINT)->cannotBeEmpty()->end()
                ->floatNode('timeout')->defaultValue(2.0)->min(0.001)->end()
                ->integerNode('max_retries')->defaultValue(0)->min(0)->end()
                ->enumNode('level')->values([
                    'debug',
                    'info',
                    'notice',
                    'warning',
                    'error',
                    'critical',
                    'alert',
                    'emergency',
                ])->defaultValue('warning')->end()
                ->booleanNode('capture_requests')->defaultTrue()->end()
                ->booleanNode('capture_exceptions')->defaultTrue()->end()
                ->booleanNode('include_exception_message')->defaultFalse()->end()
                ->booleanNode('include_exception_trace')->defaultFalse()->end()
                ->scalarNode('context_provider')->defaultNull()->cannotBeEmpty()->end()
            ->end();
    }

    public function prependExtension(ContainerConfigurator $configurator, ContainerBuilder $container): void
    {
        if (!$container->hasExtension('monolog')) {
            return;
        }

        $container->prependExtensionConfig('monolog', [
            'handlers' => [
                'logbrew' => [
                    'type' => 'service',
                    'id' => 'logbrew.symfony.monolog_handler',
                    'channels' => ['!event', '!request', '!doctrine', '!deprecation'],
                ],
            ],
        ]);
    }

    /** @param SymfonyBundleConfig $config */
    public function loadExtension(
        array $config,
        ContainerConfigurator $configurator,
        ContainerBuilder $container
    ): void {
        $rawKernelEnvironment = $container->hasParameter('kernel.environment')
            ? $container->getParameter('kernel.environment')
            : null;
        $kernelEnvironment = is_string($rawKernelEnvironment) ? $rawKernelEnvironment : 'production';
        $environment = is_string($config['environment'])
            ? $config['environment']
            : $kernelEnvironment;

        $contextProvider = is_string($config['context_provider'])
            ? new Reference($config['context_provider'])
            : null;
        $telemetry = new Definition(SymfonyTelemetry::class, [
            $config['enabled'],
            $config['api_key'],
            $config['service'],
            $config['release'],
            $environment,
            null,
            null,
            null,
            $config['endpoint'],
            $config['timeout'],
            $config['max_retries'],
            $config['level'],
            $config['capture_requests'],
            $config['capture_exceptions'],
            $config['include_exception_message'],
            $config['include_exception_trace'],
            null,
            null,
            $contextProvider,
        ]);
        $telemetry->setPublic(false);
        $container->setDefinition('logbrew.symfony.telemetry', $telemetry);
        $container->setAlias(SymfonyTelemetry::class, 'logbrew.symfony.telemetry')->setPublic(false);

        if (interface_exists(HandlerInterface::class)) {
            $handler = new Definition(HandlerInterface::class);
            $handler->setFactory([new Reference('logbrew.symfony.telemetry'), 'monologHandler']);
            $handler->setPublic(false);
            $container->setDefinition('logbrew.symfony.monolog_handler', $handler);
        }

        $subscriber = new Definition(SymfonyRequestSubscriber::class, [
            new Reference('logbrew.symfony.telemetry'),
        ]);
        $subscriber->addTag('kernel.event_subscriber');
        $subscriber->setPublic(false);
        $container->setDefinition('logbrew.symfony.request_subscriber', $subscriber);
        $container->setAlias(SymfonyRequestSubscriber::class, 'logbrew.symfony.request_subscriber')->setPublic(false);

        if (interface_exists(MiddlewareInterface::class)) {
            $messenger = new Definition(SymfonyMessengerTelemetry::class);
            $messenger->setFactory([new Reference('logbrew.symfony.telemetry'), 'messengerTelemetry']);
            $messenger->addTag('kernel.event_subscriber');
            $messenger->setPublic(false);
            $container->setDefinition('logbrew.symfony.messenger', $messenger);
        }

        if (class_exists(Command::class)) {
            $statusCommand = new Definition(SymfonyStatusCommand::class, [
                new Reference('logbrew.symfony.telemetry'),
            ]);
            $statusCommand->addTag('console.command');
            $statusCommand->setPublic(false);
            $container->setDefinition('logbrew.symfony.status_command', $statusCommand);
        }
    }
}
