import bullMq from "./index.cjs";

const {
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqFlowJob,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
} = bullMq;
const defaultExport = bullMq.default;

export {
  bullMqFlowProducerAddWithLogBrewSpan,
  bullMqQueueAddBulkWithLogBrewSpan,
  bullMqQueueAddWithLogBrewSpan,
  createLogBrewBullMqFlowJob,
  createLogBrewBullMqJobOptions,
  extractLogBrewBullMqTraceparent,
  instrumentLogBrewBullMqFlowProducer,
  instrumentLogBrewBullMqProcessor,
  instrumentLogBrewBullMqQueue,
  withLogBrewBullMqProcessor
};
export default defaultExport;
