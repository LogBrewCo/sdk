import awsSqs from "./index.cjs";

const {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
  createLogBrewSqsTraceLinks,
  eventBridgePutEventsWithLogBrewSpan,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  snsPublishBatchWithLogBrewSpan,
  snsPublishWithLogBrewSpan,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
} = awsSqs;
const defaultExport = awsSqs.default;

export {
  createLogBrewEventBridgePutEventsInput,
  createLogBrewSnsPublishBatchInput,
  createLogBrewSnsPublishInput,
  createLogBrewSqsReceiveMessageInput,
  createLogBrewSqsSendMessageBatchInput,
  createLogBrewSqsSendMessageInput,
  createLogBrewSqsTraceLinks,
  eventBridgePutEventsWithLogBrewSpan,
  extractLogBrewSqsTraceparent,
  instrumentLogBrewSqsClient,
  snsPublishBatchWithLogBrewSpan,
  snsPublishWithLogBrewSpan,
  sqsReceiveMessageWithLogBrewSpan,
  sqsSendMessageBatchWithLogBrewSpan,
  sqsSendMessageWithLogBrewSpan,
  withLogBrewSqsMessageProcessor
};
export default defaultExport;
