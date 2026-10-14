import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConfluenceClient } from "../confluence-client.js";
import { MAX_DOWNLOAD_BYTES } from "../http.js";
import type { JiraClient } from "../jira-client.js";
import { READ_ONLY_ANNOTATIONS } from "./shared.js";

// Bigger images blow up the context when base64-encoded, so they are only saved to disk.
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Makes an attachment name safe to use as a file name.
 *
 * @param name Original file name.
 * @returns Name with unsafe characters replaced by _, at most 100 characters.
 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 100) || "attachment";
}

/**
 * Saves a downloaded file to disk and builds the tool result, inlining images that are small enough.
 *
 * @param file Downloaded bytes and the attachment's identity.
 * @param options Where to save and whether to inline images.
 * @returns MCP tool result with the saved path and, for images, the image itself.
 */
async function saveDownload(
  file: { data: Buffer; mimeType: string; id: string; filename?: string },
  options: { downloadDir: string; outputPath?: string; inline?: boolean }
) {
  const { data, mimeType, id, filename } = file;
  const fileName = `${id}-${sanitizeFileName(filename ?? id)}`;
  let target = path.join(options.downloadDir, fileName);

  if (options.outputPath) {
    const resolved = path.resolve(options.outputPath.replace(/^~(?=$|[\\/])/, os.homedir()));
    const isDir = await stat(resolved).then(
      (entry) => entry.isDirectory(),
      () => false
    );
    target = isDir ? path.join(resolved, fileName) : resolved;
  }

  await mkdir(path.dirname(target), { recursive: true });
  // Attachment content is untrusted, so an explicit path must not clobber an existing file
  // (e.g. a shell profile); the default download dir is ours and may be overwritten.
  await writeFile(target, data, { flag: options.outputPath ? "wx" : "w" }).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    }
    throw error;
  });

  const isImage = mimeType.startsWith("image/");
  const tooLarge = data.byteLength > MAX_INLINE_IMAGE_BYTES;
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    {
      type: "text",
      text:
        `Saved ${filename ?? id} (${mimeType}, ${data.byteLength} bytes) to ${target}` +
        (isImage && tooLarge ? "\nImage not inlined: larger than the inline limit; read the saved file instead." : "")
    }
  ];

  if (isImage && !tooLarge && options.inline !== false) {
    content.push({ type: "image", data: data.toString("base64"), mimeType });
  }

  return { content };
}

const outputPathParam = z
  .string()
  .optional()
  .describe(
    "File or existing directory to save into; defaults to JIRA_ATTACHMENT_DIR or the system temp dir. " +
      "Existing files are never overwritten."
  );
const inlineParam = z
  .boolean()
  .optional()
  .describe("Return the image content as well (default true for images under the size limit).");

/**
 * Registers jira_download_attachment and confluence_download_attachment.
 *
 * @param server MCP server to add the tools to.
 * @param jira Jira client used to fetch Jira files.
 * @param confluence Confluence client used to fetch Confluence files.
 * @param downloadDir Default directory to save into.
 */
export function registerAttachmentTools(
  server: McpServer,
  jira: JiraClient,
  confluence: ConfluenceClient,
  downloadDir: string
) {
  server.registerTool(
    "jira_download_attachment",
    {
      title: "Download Jira attachment",
      description:
        "Download an attachment (e.g. a screenshot) by its id from jira_list_attachments. Saves it to disk and, " +
        "for images, also returns the image itself so it can be looked at directly.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        attachmentId: z.string().min(1).describe("Attachment id from jira_list_attachments."),
        outputPath: outputPathParam,
        inline: inlineParam
      }
    },
    async ({ attachmentId, outputPath, inline }) => {
      const meta = await jira.getAttachmentMeta(attachmentId);
      if (Number(meta?.size) > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Attachment ${attachmentId} is ${meta.size} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte limit`);
      }

      const { data, mimeType } = await jira.downloadAttachment(attachmentId);
      return saveDownload(
        { data, mimeType: meta?.mimeType || mimeType, id: attachmentId, filename: meta?.filename },
        { downloadDir, outputPath, inline }
      );
    }
  );

  server.registerTool(
    "confluence_download_attachment",
    {
      title: "Download Confluence attachment",
      description:
        "Download a page attachment by its id from confluence_list_attachments. Saves it to disk and, for " +
        "images, also returns the image itself.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        attachmentId: z.string().min(1).describe("Attachment id from confluence_list_attachments."),
        outputPath: outputPathParam,
        inline: inlineParam
      }
    },
    async ({ attachmentId, outputPath, inline }) => {
      const meta = await confluence.getAttachmentMeta(attachmentId);
      if (Number(meta?.fileSize) > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `Attachment ${attachmentId} is ${meta.fileSize} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte limit`
        );
      }

      const { data, mimeType } = await confluence.downloadAttachment(meta);
      return saveDownload(
        { data, mimeType: meta?.mediaType || mimeType, id: attachmentId, filename: meta?.title },
        { downloadDir, outputPath, inline }
      );
    }
  );
}
