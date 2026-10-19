import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs"

export type AwsQueue = {
  readonly client: SQSClient
  readonly queueUrl: string
}

/**
 * Opens the SQS client the workload uses. The endpoint is the dependency mock,
 * not Floci: the mock is the witness that counts what the SDK actually sent.
 * `useQueueUrlAsEndpoint` is off so the QueueUrl Floci returns cannot redirect
 * SendMessage around the witness.
 */
export async function openAwsQueue(options: {
  endpoint: string
  queueName: string
  region?: string
}): Promise<AwsQueue> {
  const client = new SQSClient({
    endpoint: options.endpoint,
    region: options.region ?? "us-east-1",
    maxAttempts: 1,
    useQueueUrlAsEndpoint: false,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  })
  const created = await client.send(
    new CreateQueueCommand({ QueueName: options.queueName }),
  )
  if (created.QueueUrl === undefined) {
    client.destroy()
    throw new Error(`SQS did not return a QueueUrl for ${options.queueName}`)
  }
  return { client, queueUrl: created.QueueUrl }
}
