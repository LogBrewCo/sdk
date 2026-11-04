<?php

declare(strict_types=1);

putenv('LOGBREW_RELEASE=checkout@1.2.3');
putenv('LOGBREW_ENVIRONMENT=production');
putenv('LOGBREW_SERVICE_NAME=checkout-api');

$socket = stream_socket_server('tcp://127.0.0.1:0');
$address = stream_socket_get_name($socket, false);
fclose($socket);
$server = proc_open([PHP_BINARY, '-S', $address, __DIR__ . '/app.php'], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
$traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
$get = static function (string $path) use ($address, $traceparent): int {
    $context = stream_context_create(['http' => ['header' => "traceparent: $traceparent\r\n", 'ignore_errors' => true, 'timeout' => 5]]);
    for ($attempt = 0; $attempt < 50; $attempt++) {
        $stream = @fopen("http://$address$path", 'r', false, $context);
        if ($stream !== false) {
            $status = (int) explode(' ', stream_get_meta_data($stream)['wrapper_data'][0])[1];
            fclose($stream);
            return $status;
        }
        usleep(100_000);
    }
    throw new RuntimeException("no response from $path");
};
try {
    $get('/checkout/cart-1') === 200 || throw new RuntimeException('success request failed');
    $get('/fail/cart-2') === 500 || throw new RuntimeException('failing request did not fail');
} finally {
    proc_terminate($server);
    proc_close($server);
}
