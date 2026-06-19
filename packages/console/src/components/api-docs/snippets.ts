// Shared OpenAI-SDK snippet definitions.
//
// Used in two places: the "Show usage example" dialog on /account
// (a quick-access affordance for a signed-in user staring at their
// API key), and the standalone /docs/inference page (a public, deeply-
// linkable reference). Keeping the strings in one module avoids
// drift between those two surfaces.

import dedent from "dedent";

export type SnippetLang = "curl" | "python" | "typescript" | "java" | "go" | "csharp";

export const SNIPPET_LANG_LABELS: Record<SnippetLang, string> = {
  curl: "curl",
  python: "Python",
  typescript: "TypeScript",
  java: "Java",
  go: "Go",
  csharp: "C#",
};

/** Stable order so the SegmentedControl renders the same way across
 *  browsers. TypeScript first — it's the default selection on /docs/inference
 *  and the closest match to the console's own stack; curl + the rest
 *  follow in roughly popularity-of-OpenAI-SDK order. */
export const SNIPPET_LANGS: ReadonlyArray<SnippetLang> = [
  "typescript",
  "curl",
  "python",
  "java",
  "go",
  "csharp",
];

export function buildSnippet(lang: SnippetLang, baseUrl: string, model: string): string {
  switch (lang) {
    case "curl":
      return dedent`
        curl ${baseUrl}/chat/completions \\
          -H "Authorization: Bearer cocore-..." \\
          -H "Content-Type: application/json" \\
          -d '{
            "model": "${model}",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": true
          }'
      `;
    case "python":
      return dedent`
        from openai import OpenAI

        client = OpenAI(
            base_url="${baseUrl}",
            api_key="cocore-...",
        )

        response = client.chat.completions.create(
            model="${model}",
            messages=[{"role": "user", "content": "Hello"}],
            stream=True,
        )
        for chunk in response:
            print(chunk.choices[0].delta.content or "", end="")
      `;
    case "typescript":
      return dedent`
        import OpenAI from "openai";

        const client = new OpenAI({
          baseURL: "${baseUrl}",
          apiKey: "cocore-...",
        });

        const stream = await client.chat.completions.create({
          model: "${model}",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        });

        for await (const chunk of stream) {
          process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
        }
      `;
    case "java":
      return dedent`
        import com.openai.client.OpenAIClient;
        import com.openai.client.okhttp.OpenAIOkHttpClient;
        import com.openai.models.chat.completions.ChatCompletionCreateParams;

        OpenAIClient client = OpenAIOkHttpClient.builder()
            .baseUrl("${baseUrl}")
            .apiKey("cocore-...")
            .build();

        ChatCompletionCreateParams params = ChatCompletionCreateParams.builder()
            .model("${model}")
            .addUserMessage("Hello")
            .build();

        client.chat().completions().createStreaming(params)
            .stream()
            .flatMap(c -> c.choices().stream())
            .flatMap(c -> c.delta().content().stream())
            .forEach(System.out::print);
      `;
    case "go":
      return dedent`
        package main

        import (
            "context"
            "fmt"

            "github.com/openai/openai-go"
            "github.com/openai/openai-go/option"
        )

        func main() {
            client := openai.NewClient(
                option.WithBaseURL("${baseUrl}"),
                option.WithAPIKey("cocore-..."),
            )

            stream := client.Chat.Completions.NewStreaming(context.TODO(), openai.ChatCompletionNewParams{
                Model: openai.ChatModel("${model}"),
                Messages: []openai.ChatCompletionMessageParamUnion{
                    openai.UserMessage("Hello"),
                },
            })
            for stream.Next() {
                chunk := stream.Current()
                if len(chunk.Choices) > 0 {
                    fmt.Print(chunk.Choices[0].Delta.Content)
                }
            }
        }
      `;
    case "csharp":
      return dedent`
        using OpenAI.Chat;
        using System.ClientModel;

        ChatClient client = new(
            model: "${model}",
            credential: new ApiKeyCredential("cocore-..."),
            options: new() { Endpoint = new Uri("${baseUrl}") });

        foreach (var update in client.CompleteChatStreaming("Hello"))
        {
            foreach (var part in update.ContentUpdate)
            {
                Console.Write(part.Text);
            }
        }
      `;
  }
}

/** Map our snippet langs to shiki language identifiers for syntax
 *  highlighting. Keep in sync with `highlightCodeQueryOptions`. */
export const SNIPPET_LANG_TO_SHIKI: Record<SnippetLang, string> = {
  curl: "bash",
  python: "python",
  typescript: "typescript",
  java: "java",
  go: "go",
  csharp: "csharp",
};
