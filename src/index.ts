import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import os from "os";
import { createEmailMessage, createEmailWithNodemailer } from "./utl.js";
import {
  createLabel,
  updateLabel,
  deleteLabel,
  listLabels,
  getOrCreateLabel,
  GmailLabel,
} from "./label-manager.js";

// Type definitions for Gmail API responses
interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface EmailContent {
  text: string;
  html: string;
}

/**
 * Recursively extract email body content from MIME message parts
 * Handles complex email structures with nested parts
 */
function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
  // Initialize containers for different content types
  let textContent = "";
  let htmlContent = "";

  // If the part has a body with data, process it based on MIME type
  if (messagePart.body && messagePart.body.data) {
    const content = Buffer.from(messagePart.body.data, "base64").toString(
      "utf8",
    );

    // Store content based on its MIME type
    if (messagePart.mimeType === "text/plain") {
      textContent = content;
    } else if (messagePart.mimeType === "text/html") {
      htmlContent = content;
    }
  }

  // If the part has nested parts, recursively process them
  if (messagePart.parts && messagePart.parts.length > 0) {
    for (const part of messagePart.parts) {
      const { text, html } = extractEmailContent(part);
      if (text) textContent += text;
      if (html) htmlContent += html;
    }
  }

  // Return both plain text and HTML content
  return { text: textContent, html: htmlContent };
}

const SendEmailSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  to: z.array(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z
    .string()
    .describe(
      "Email body content (used for text/plain or when htmlBody not provided)",
    ),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z
    .enum(["text/plain", "text/html", "multipart/alternative"])
    .optional()
    .default("text/plain")
    .describe("Email content type"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
  threadId: z.string().optional().describe("Thread ID to reply to"),
  inReplyTo: z.string().optional().describe("Message ID being replied to"),
  attachments: z
    .array(z.string())
    .optional()
    .describe("List of file paths to attach to the email"),
});

const ReadEmailSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  messageId: z.string().describe("ID of the email message to retrieve"),
});

const SearchEmailsSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  query: z
    .string()
    .describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: z
    .number()
    .optional()
    .describe("Maximum number of results to return"),
});

// Updated schema to include removeLabelIds
const ModifyEmailSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  messageId: z.string().describe("ID of the email message to modify"),
  labelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to apply"),
  addLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to add to the message"),
  removeLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to remove from the message"),
});

const DeleteEmailSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  messageId: z.string().describe("ID of the email message to delete"),
});

// New schema for listing email labels
const ListEmailLabelsSchema = z
  .object({
    access_token: z.string().describe("OAuth2 access token"),
  })
  .describe("Retrieves all available Gmail labels");

// Label management schemas
const CreateLabelSchema = z
  .object({
    access_token: z.string().describe("OAuth2 access token"),
    name: z.string().describe("Name for the new label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Creates a new Gmail label");

const UpdateLabelSchema = z
  .object({
    access_token: z.string().describe("OAuth2 access token"),
    id: z.string().describe("ID of the label to update"),
    name: z.string().optional().describe("New name for the label"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Updates an existing Gmail label");

const DeleteLabelSchema = z
  .object({
    access_token: z.string().describe("OAuth2 access token"),
    id: z.string().describe("ID of the label to delete"),
  })
  .describe("Deletes a Gmail label");

const GetOrCreateLabelSchema = z
  .object({
    access_token: z.string().describe("OAuth2 access token"),
    name: z.string().describe("Name of the label to get or create"),
    messageListVisibility: z
      .enum(["show", "hide"])
      .optional()
      .describe("Whether to show or hide the label in the message list"),
    labelListVisibility: z
      .enum(["labelShow", "labelShowIfUnread", "labelHide"])
      .optional()
      .describe("Visibility of the label in the label list"),
  })
  .describe("Gets an existing label by name or creates it if it doesn't exist");

// Schemas for batch operations
const BatchModifyEmailsSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  messageIds: z.array(z.string()).describe("List of message IDs to modify"),
  addLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to add to all messages"),
  removeLabelIds: z
    .array(z.string())
    .optional()
    .describe("List of label IDs to remove from all messages"),
  batchSize: z
    .number()
    .optional()
    .default(50)
    .describe("Number of messages to process in each batch (default: 50)"),
});

const BatchDeleteEmailsSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  messageIds: z.array(z.string()).describe("List of message IDs to delete"),
  batchSize: z
    .number()
    .optional()
    .default(50)
    .describe("Number of messages to process in each batch (default: 50)"),
});

const DownloadAttachmentSchema = z.object({
  access_token: z.string().describe("OAuth2 access token"),
  messageId: z
    .string()
    .describe("ID of the email message containing the attachment"),
  attachmentId: z.string().describe("ID of the attachment to download"),
  filename: z
    .string()
    .optional()
    .describe(
      "Filename to save the attachment as (if not provided, uses original filename)",
    ),
  savePath: z
    .string()
    .optional()
    .describe(
      "Directory path to save the attachment (defaults to current directory)",
    ),
});

async function get_gmail_sdk(access_token: string) {
  let oauth2Client: OAuth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: access_token });

  let gmail = google.gmail({ version: "v1", auth: oauth2Client });
  return gmail;
}

// Main function
async function main() {
  const PROJECT_DIR = path.join(
    os.homedir(),
    "Documents",
    "dev",
    "Gmail-MCP-Server",
  );
  const logPath = path.join(PROJECT_DIR, "server.log");
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] server started\n`);

  // Server implementation
  const server = new Server({
    name: "gmail",
    version: "1.0.0",
    capabilities: {
      tools: {},
    },
  });

  // Tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send_email",
        description: "Sends a new email",
        inputSchema: zodToJsonSchema(SendEmailSchema),
      },
      {
        name: "draft_email",
        description: "Draft a new email",
        inputSchema: zodToJsonSchema(SendEmailSchema),
      },
      {
        name: "read_email",
        description: "Retrieves the content of a specific email",
        inputSchema: zodToJsonSchema(ReadEmailSchema),
      },
      {
        name: "search_emails",
        description: "Searches for emails using Gmail search syntax",
        inputSchema: zodToJsonSchema(SearchEmailsSchema),
      },
      {
        name: "modify_email",
        description: "Modifies email labels (move to different folders)",
        inputSchema: zodToJsonSchema(ModifyEmailSchema),
      },
      {
        name: "delete_email",
        description: "Permanently deletes an email",
        inputSchema: zodToJsonSchema(DeleteEmailSchema),
      },
      {
        name: "list_email_labels",
        description: "Retrieves all available Gmail labels",
        inputSchema: zodToJsonSchema(ListEmailLabelsSchema),
      },
      {
        name: "batch_modify_emails",
        description: "Modifies labels for multiple emails in batches",
        inputSchema: zodToJsonSchema(BatchModifyEmailsSchema),
      },
      {
        name: "batch_delete_emails",
        description: "Permanently deletes multiple emails in batches",
        inputSchema: zodToJsonSchema(BatchDeleteEmailsSchema),
      },
      {
        name: "create_label",
        description: "Creates a new Gmail label",
        inputSchema: zodToJsonSchema(CreateLabelSchema),
      },
      {
        name: "update_label",
        description: "Updates an existing Gmail label",
        inputSchema: zodToJsonSchema(UpdateLabelSchema),
      },
      {
        name: "delete_label",
        description: "Deletes a Gmail label",
        inputSchema: zodToJsonSchema(DeleteLabelSchema),
      },
      {
        name: "get_or_create_label",
        description:
          "Gets an existing label by name or creates it if it doesn't exist",
        inputSchema: zodToJsonSchema(GetOrCreateLabelSchema),
      },
      {
        name: "download_attachment",
        description: "Downloads an email attachment to a specified location",
        inputSchema: zodToJsonSchema(DownloadAttachmentSchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] Request: ${JSON.stringify(request)}\n`,
    );
    const { name, arguments: args } = request.params;

    async function handleEmailAction(
      action: "send" | "draft",
      validatedArgs: any,
    ) {
      let message: string;

      try {
        // Check if we have attachments
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
          // Use Nodemailer to create properly formatted RFC822 message
          message = await createEmailWithNodemailer(validatedArgs);

          if (action === "send") {
            const encodedMessage = Buffer.from(message)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            let gmail = await get_gmail_sdk(validatedArgs.access_token);
            const result = await gmail.users.messages.send({
              userId: "me",
              requestBody: {
                raw: encodedMessage,
                ...(validatedArgs.threadId && {
                  threadId: validatedArgs.threadId,
                }),
              },
            });

            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully with ID: ${result.data.id}`,
                },
              ],
            };
          } else {
            // For drafts with attachments, use the raw message
            const encodedMessage = Buffer.from(message)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            const messageRequest = {
              raw: encodedMessage,
              ...(validatedArgs.threadId && {
                threadId: validatedArgs.threadId,
              }),
            };

            let gmail = await get_gmail_sdk(validatedArgs.access_token);
            const response = await gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: messageRequest,
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email draft created successfully with ID: ${response.data.id}`,
                },
              ],
            };
          }
        } else {
          // For emails without attachments, use the existing simple method
          message = createEmailMessage(validatedArgs);

          const encodedMessage = Buffer.from(message)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          // Define the type for messageRequest
          interface GmailMessageRequest {
            raw: string;
            threadId?: string;
          }

          const messageRequest: GmailMessageRequest = {
            raw: encodedMessage,
          };

          // Add threadId if specified
          if (validatedArgs.threadId) {
            messageRequest.threadId = validatedArgs.threadId;
          }

          if (action === "send") {
            let gmail = await get_gmail_sdk(validatedArgs.access_token);
            const response = await gmail.users.messages.send({
              userId: "me",
              requestBody: messageRequest,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email sent successfully with ID: ${response.data.id}`,
                },
              ],
            };
          } else {
            let gmail = await get_gmail_sdk(validatedArgs.access_token);
            const response = await gmail.users.drafts.create({
              userId: "me",
              requestBody: {
                message: messageRequest,
              },
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Email draft created successfully with ID: ${response.data.id}`,
                },
              ],
            };
          }
        }
      } catch (error: any) {
        // Log attachment-related errors for debugging
        if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
          console.error(
            `Failed to send email with ${validatedArgs.attachments.length} attachments:`,
            error.message,
          );
        }
        throw error;
      }
    }

    // Helper function to process operations in batches
    async function processBatches<T, U>(
      items: T[],
      batchSize: number,
      processFn: (batch: T[]) => Promise<U[]>,
    ): Promise<{ successes: U[]; failures: { item: T; error: Error }[] }> {
      const successes: U[] = [];
      const failures: { item: T; error: Error }[] = [];

      // Process in batches
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        try {
          const results = await processFn(batch);
          successes.push(...results);
        } catch (error) {
          // If batch fails, try individual items
          for (const item of batch) {
            try {
              const result = await processFn([item]);
              successes.push(...result);
            } catch (itemError) {
              failures.push({ item, error: itemError as Error });
            }
          }
        }
      }

      return { successes, failures };
    }

    try {
      switch (name) {
        case "send_email":
        case "draft_email": {
          const validatedArgs = SendEmailSchema.parse(args);
          const action = name === "send_email" ? "send" : "draft";
          return await handleEmailAction(action, validatedArgs);
        }

        case "read_email": {
          const validatedArgs = ReadEmailSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          const response = await gmail.users.messages.get({
            userId: "me",
            id: validatedArgs.messageId,
            format: "full",
          });

          const headers = response.data.payload?.headers || [];
          const subject =
            headers.find((h) => h.name?.toLowerCase() === "subject")?.value ||
            "";
          const from =
            headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
          const to =
            headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
          const date =
            headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";
          const threadId = response.data.threadId || "";

          // Extract email content using the recursive function
          const { text, html } = extractEmailContent(
            (response.data.payload as GmailMessagePart) || {},
          );

          // Use plain text content if available, otherwise use HTML content
          // (optionally, you could implement HTML-to-text conversion here)
          let body = text || html || "";

          // If we only have HTML content, add a note for the user
          const contentTypeNote =
            !text && html
              ? "[Note: This email is HTML-formatted. Plain text version not available.]\n\n"
              : "";

          // Get attachment information
          const attachments: EmailAttachment[] = [];
          const processAttachmentParts = (
            part: GmailMessagePart,
            path: string = "",
          ) => {
            if (part.body && part.body.attachmentId) {
              const filename =
                part.filename || `attachment-${part.body.attachmentId}`;
              attachments.push({
                id: part.body.attachmentId,
                filename: filename,
                mimeType: part.mimeType || "application/octet-stream",
                size: part.body.size || 0,
              });
            }

            if (part.parts) {
              part.parts.forEach((subpart: GmailMessagePart) =>
                processAttachmentParts(subpart, `${path}/parts`),
              );
            }
          };

          if (response.data.payload) {
            processAttachmentParts(response.data.payload as GmailMessagePart);
          }

          // Add attachment info to output if any are present
          const attachmentInfo =
            attachments.length > 0
              ? `\n\nAttachments (${attachments.length}):\n` +
                attachments
                  .map(
                    (a) =>
                      `- ${a.filename} (${a.mimeType}, ${Math.round(
                        a.size / 1024,
                      )} KB, ID: ${a.id})`,
                  )
                  .join("\n")
              : "";

          return {
            content: [
              {
                type: "text",
                text: `Thread ID: ${threadId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${contentTypeNote}${body}${attachmentInfo}`,
              },
            ],
          };
        }

        case "search_emails": {
          const validatedArgs = SearchEmailsSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          const response = await gmail.users.messages.list({
            userId: "me",
            q: validatedArgs.query,
            maxResults: validatedArgs.maxResults || 10,
          });

          fs.appendFileSync(
            logPath,
            `[${new Date().toISOString()}] Emails: ${JSON.stringify(
              response,
            )}\n`,
          );

          const messages = response.data.messages || [];
          const results = await Promise.all(
            messages.map(async (msg) => {
              const detail = await gmail.users.messages.get({
                userId: "me",
                id: msg.id!,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
              });
              const headers = detail.data.payload?.headers || [];
              return {
                id: msg.id,
                subject: headers.find((h) => h.name === "Subject")?.value || "",
                from: headers.find((h) => h.name === "From")?.value || "",
                date: headers.find((h) => h.name === "Date")?.value || "",
              };
            }),
          );

          return {
            content: [
              {
                type: "text",
                text: results
                  .map(
                    (r) =>
                      `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`,
                  )
                  .join("\n"),
              },
            ],
          };
        }

        // Updated implementation for the modify_email handler
        case "modify_email": {
          const validatedArgs = ModifyEmailSchema.parse(args);

          // Prepare request body
          const requestBody: any = {};

          if (validatedArgs.labelIds) {
            requestBody.addLabelIds = validatedArgs.labelIds;
          }

          if (validatedArgs.addLabelIds) {
            requestBody.addLabelIds = validatedArgs.addLabelIds;
          }

          if (validatedArgs.removeLabelIds) {
            requestBody.removeLabelIds = validatedArgs.removeLabelIds;
          }

          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          await gmail.users.messages.modify({
            userId: "me",
            id: validatedArgs.messageId,
            requestBody: requestBody,
          });

          return {
            content: [
              {
                type: "text",
                text: `Email ${validatedArgs.messageId} labels updated successfully`,
              },
            ],
          };
        }

        case "delete_email": {
          const validatedArgs = DeleteEmailSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          await gmail.users.messages.delete({
            userId: "me",
            id: validatedArgs.messageId,
          });

          return {
            content: [
              {
                type: "text",
                text: `Email ${validatedArgs.messageId} deleted successfully`,
              },
            ],
          };
        }

        case "list_email_labels": {
          const validatedArgs = ListEmailLabelsSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);

          const labelResults = await listLabels(gmail);
          const systemLabels = labelResults.system;
          const userLabels = labelResults.user;

          return {
            content: [
              {
                type: "text",
                text:
                  `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                  "System Labels:\n" +
                  systemLabels
                    .map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`)
                    .join("\n") +
                  "\nUser Labels:\n" +
                  userLabels
                    .map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`)
                    .join("\n"),
              },
            ],
          };
        }

        case "batch_modify_emails": {
          const validatedArgs = BatchModifyEmailsSchema.parse(args);
          const messageIds = validatedArgs.messageIds;
          const batchSize = validatedArgs.batchSize || 50;

          // Prepare request body
          const requestBody: any = {};

          if (validatedArgs.addLabelIds) {
            requestBody.addLabelIds = validatedArgs.addLabelIds;
          }

          if (validatedArgs.removeLabelIds) {
            requestBody.removeLabelIds = validatedArgs.removeLabelIds;
          }

          // Process messages in batches
          const { successes, failures } = await processBatches(
            messageIds,
            batchSize,
            async (batch) => {
              const results = await Promise.all(
                batch.map(async (messageId) => {
                  const gmail = await get_gmail_sdk(validatedArgs.access_token);
                  const result = await gmail.users.messages.modify({
                    userId: "me",
                    id: messageId,
                    requestBody: requestBody,
                  });
                  return { messageId, success: true };
                }),
              );
              return results;
            },
          );

          // Generate summary of the operation
          const successCount = successes.length;
          const failureCount = failures.length;

          let resultText = `Batch label modification complete.\n`;
          resultText += `Successfully processed: ${successCount} messages\n`;

          if (failureCount > 0) {
            resultText += `Failed to process: ${failureCount} messages\n\n`;
            resultText += `Failed message IDs:\n`;
            resultText += failures
              .map(
                (f) =>
                  `- ${(f.item as string).substring(0, 16)}... (${
                    f.error.message
                  })`,
              )
              .join("\n");
          }

          return {
            content: [
              {
                type: "text",
                text: resultText,
              },
            ],
          };
        }

        case "batch_delete_emails": {
          const validatedArgs = BatchDeleteEmailsSchema.parse(args);
          const messageIds = validatedArgs.messageIds;
          const batchSize = validatedArgs.batchSize || 50;

          // Process messages in batches
          const { successes, failures } = await processBatches(
            messageIds,
            batchSize,
            async (batch) => {
              const results = await Promise.all(
                batch.map(async (messageId) => {
                  const gmail = await get_gmail_sdk(validatedArgs.access_token);
                  await gmail.users.messages.delete({
                    userId: "me",
                    id: messageId,
                  });
                  return { messageId, success: true };
                }),
              );
              return results;
            },
          );

          // Generate summary of the operation
          const successCount = successes.length;
          const failureCount = failures.length;

          let resultText = `Batch delete operation complete.\n`;
          resultText += `Successfully deleted: ${successCount} messages\n`;

          if (failureCount > 0) {
            resultText += `Failed to delete: ${failureCount} messages\n\n`;
            resultText += `Failed message IDs:\n`;
            resultText += failures
              .map(
                (f) =>
                  `- ${(f.item as string).substring(0, 16)}... (${
                    f.error.message
                  })`,
              )
              .join("\n");
          }

          return {
            content: [
              {
                type: "text",
                text: resultText,
              },
            ],
          };
        }

        // New label management handlers
        case "create_label": {
          const validatedArgs = CreateLabelSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          const result = await createLabel(gmail, validatedArgs.name, {
            messageListVisibility: validatedArgs.messageListVisibility,
            labelListVisibility: validatedArgs.labelListVisibility,
          });

          return {
            content: [
              {
                type: "text",
                text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
              },
            ],
          };
        }

        case "update_label": {
          const validatedArgs = UpdateLabelSchema.parse(args);

          // Prepare request body with only the fields that were provided
          const updates: any = {};
          if (validatedArgs.name) updates.name = validatedArgs.name;
          if (validatedArgs.messageListVisibility)
            updates.messageListVisibility = validatedArgs.messageListVisibility;
          if (validatedArgs.labelListVisibility)
            updates.labelListVisibility = validatedArgs.labelListVisibility;

          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          const result = await updateLabel(gmail, validatedArgs.id, updates);

          return {
            content: [
              {
                type: "text",
                text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
              },
            ],
          };
        }

        case "delete_label": {
          const validatedArgs = DeleteLabelSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          const result = await deleteLabel(gmail, validatedArgs.id);

          return {
            content: [
              {
                type: "text",
                text: result.message,
              },
            ],
          };
        }

        case "get_or_create_label": {
          const validatedArgs = GetOrCreateLabelSchema.parse(args);
          const gmail = await get_gmail_sdk(validatedArgs.access_token);
          const result = await getOrCreateLabel(gmail, validatedArgs.name, {
            messageListVisibility: validatedArgs.messageListVisibility,
            labelListVisibility: validatedArgs.labelListVisibility,
          });

          const action =
            result.type === "user" && result.name === validatedArgs.name
              ? "found existing"
              : "created new";

          return {
            content: [
              {
                type: "text",
                text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
              },
            ],
          };
        }

        case "download_attachment": {
          const validatedArgs = DownloadAttachmentSchema.parse(args);

          try {
            const gmail = await get_gmail_sdk(validatedArgs.access_token);
            // Get the attachment data from Gmail API
            const attachmentResponse =
              await gmail.users.messages.attachments.get({
                userId: "me",
                messageId: validatedArgs.messageId,
                id: validatedArgs.attachmentId,
              });

            if (!attachmentResponse.data.data) {
              throw new Error("No attachment data received");
            }

            // Decode the base64 data
            const data = attachmentResponse.data.data;
            const buffer = Buffer.from(data, "base64url");

            // Determine save path and filename
            const savePath = validatedArgs.savePath || process.cwd();
            let filename = validatedArgs.filename;

            if (!filename) {
              // Get original filename from message if not provided
              const gmail = await get_gmail_sdk(validatedArgs.access_token);
              const messageResponse = await gmail.users.messages.get({
                userId: "me",
                id: validatedArgs.messageId,
                format: "full",
              });

              // Find the attachment part to get original filename
              const findAttachment = (part: any): string | null => {
                if (
                  part.body &&
                  part.body.attachmentId === validatedArgs.attachmentId
                ) {
                  return (
                    part.filename || `attachment-${validatedArgs.attachmentId}`
                  );
                }
                if (part.parts) {
                  for (const subpart of part.parts) {
                    const found = findAttachment(subpart);
                    if (found) return found;
                  }
                }
                return null;
              };

              filename =
                findAttachment(messageResponse.data.payload) ||
                `attachment-${validatedArgs.attachmentId}`;
            }

            // Ensure save directory exists
            if (!fs.existsSync(savePath)) {
              fs.mkdirSync(savePath, { recursive: true });
            }

            // Write file
            const fullPath = path.join(savePath, filename);
            fs.writeFileSync(fullPath, buffer);

            return {
              content: [
                {
                  type: "text",
                  text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to download attachment: ${error.message}`,
                },
              ],
            };
          }
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
