import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { MAX_DOWNLOAD_BYTES, type JiraClient } from "../jira-client.js";
import { READ_ONLY_ANNOTATIONS } from "./shared.js";

// Bigger images blow up the context when base64-encoded, so they are only saved to disk.
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

export function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 100) || "attachment";
}

export function registerAttachmentTools(server: McpServer, client: JiraClient, downloadDir: string) {
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
        outputPath: z
          .string()
          .optional()
          .describe(
            "File or existing directory to save into; defaults to JIRA_ATTACHMENT_DIR or the system temp dir. " +
              "Existing files are never overwritten."
          ),
        inline: z
          .boolean()
          .optional()
          .describe("Return the image content as well (default true for images under the size limit).")
      }
    },
    async ({ attachmentId, outputPath, inline }) => {
      const meta = await client.getAttachmentMeta(attachmentId);
      if (Number(meta?.size) > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Attachment ${attachmentId} is ${meta.size} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte limit`);
      }

      const { data, mimeType } = await client.downloadAttachment(attachmentId);
      const resolvedMime = meta?.mimeType || mimeType;
      const fileName = `${attachmentId}-${sanitizeFileName(meta?.filename ?? attachmentId)}`;
      let target = path.join(downloadDir, fileName);

      if (outputPath) {
        const resolved = path.resolve(outputPath.replace(/^~(?=$|[\\/])/, os.homedir()));
        const isDir = await stat(resolved).then(
          (entry) => entry.isDirectory(),
          () => false
        );
        target = isDir ? path.join(resolved, fileName) : resolved;
      }

      await mkdir(path.dirname(target), { recursive: true });
      // Attachment content is untrusted, so an explicit path must not clobber an existing file
      // (e.g. a shell profile); the default download dir is ours and may be overwritten.
      await writeFile(target, data, { flag: outputPath ? "wx" : "w" }).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === "EEXIST") {
          throw new Error(`Refusing to overwrite existing file: ${target}`);
        }
        throw error;
      });

      const isImage = resolvedMime.startsWith("image/");
      const tooLarge = data.byteLength > MAX_INLINE_IMAGE_BYTES;
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        {
          type: "text",
          text:
            `Saved ${meta?.filename ?? attachmentId} (${resolvedMime}, ${data.byteLength} bytes) to ${target}` +
            (isImage && tooLarge
              ? "\nImage not inlined: larger than the inline limit; read the saved file instead."
              : "")
        }
      ];

      if (isImage && !tooLarge && inline !== false) {
        content.push({ type: "image", data: data.toString("base64"), mimeType: resolvedMime });
      }

      return { content };
    }
  );
}
