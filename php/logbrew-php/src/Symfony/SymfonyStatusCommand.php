<?php

declare(strict_types=1);

namespace LogBrew\Symfony;

use LogBrew\SdkError;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Throwable;

/** Machine- and human-readable Symfony readiness. */
#[AsCommand(
    name: 'logbrew:status',
    description: 'Show LogBrew Symfony readiness and optionally send a delivery probe.'
)]
final class SymfonyStatusCommand extends Command
{
    public function __construct(private readonly SymfonyTelemetry $telemetry)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('send-probe', null, InputOption::VALUE_NONE, 'Send one diagnostic event to the configured intake.')
            ->addOption('json', null, InputOption::VALUE_NONE, 'Print one machine-readable JSON object.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $result = $this->telemetry->status();
        $sendProbe = (bool) $input->getOption('send-probe');
        $exitCode = $result['reason'] === 'missing_api_key' ? self::INVALID : self::SUCCESS;

        if ($sendProbe) {
            if (!$this->telemetry->active()) {
                $result['delivery'] = 'not_sent';
                $exitCode = self::INVALID;
            } else {
                try {
                    $response = $this->telemetry->sendProbeEvent();
                    $result['delivery'] = 'accepted';
                    $result['statusCode'] = $response->statusCode;
                    $result['attempts'] = $response->attempts;
                } catch (Throwable $error) {
                    $result['delivery'] = 'failed';
                    $result['error'] = $error instanceof SdkError ? $error->codeName : 'unexpected_error';
                    $exitCode = self::FAILURE;
                }
            }
        }

        if ((bool) $input->getOption('json')) {
            $output->writeln(json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
            return $exitCode;
        }

        $output->writeln(sprintf('LogBrew Symfony: %s', $result['reason']));
        $output->writeln(sprintf('Service: %s', $result['service']));
        $output->writeln(sprintf('Environment: %s', $result['environment']));
        if (isset($result['delivery'])) {
            $output->writeln(sprintf('Delivery probe: %s', $result['delivery']));
        }

        return $exitCode;
    }
}
