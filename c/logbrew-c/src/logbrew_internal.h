#ifndef LOGBREW_INTERNAL_H
#define LOGBREW_INTERNAL_H

#include "logbrew.h"

LogBrewStatus logbrew_client_push_event_json(
    LogBrewClient *client,
    const char *event_type,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    LogBrewError *error);

LogBrewStatus logbrew_client_push_action_json(
    LogBrewClient *client,
    const char *id,
    const char *timestamp,
    char *attributes_json,
    LogBrewError *error);

#endif
