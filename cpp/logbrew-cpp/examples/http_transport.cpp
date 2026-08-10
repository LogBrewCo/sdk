#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>

int main() {
  const char *endpoint = std::getenv("LOGBREW_CPP_HTTP_ENDPOINT");
  if (endpoint == nullptr) {
    std::cerr << "set LOGBREW_CPP_HTTP_ENDPOINT to an http:// or https:// intake endpoint\n";
    return 2;
  }

  try {
    logbrew::LogBrewClient client(
        logbrew::Config{"LOGBREW_API_KEY", "native-cpp-http-app", logbrew::version, 1});
    client.log(
        "evt_cpp_http_transport",
        "2026-06-02T10:00:06Z",
        logbrew::LogAttributes{"c++ http transport sent", "info", "cpp-http"});
    logbrew::HttpTransport transport(endpoint, {{"x-logbrew-source", "cpp-consumer"}}, 5000L);
    const logbrew::TransportResponse response = client.flush(transport);
    if (response.status_code != 202 || response.attempts != 2U || client.pending_events() != 0U) {
      std::cerr << "unexpected HTTP response status=" << response.status_code
                << " attempts=" << response.attempts << " pending=" << client.pending_events() << '\n';
      return 1;
    }
    std::cerr << "{\"ok\":true,\"httpAttempts\":" << response.attempts << "}\n";
    return 0;
  } catch (const logbrew::SdkException &error) {
    std::cerr << error.code() << ": " << error.what() << '\n';
    return 1;
  }
}
