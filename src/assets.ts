import captainSnippet from "../examples/captain-md-snippet.md" with { type: "text" };
import configExample from "../examples/linear-workflow.example.yaml" with { type: "text" };
import outputStyle from "../examples/output-style.example.md" with { type: "text" };
import replyTemplate from "../examples/reply.example.md" with { type: "text" };
import reportTemplate from "../examples/report.example.md" with { type: "text" };
import reviewTemplate from "../examples/review-walkthrough.example.html" with { type: "text" };
import extensionManifest from "../extension/firstmate-extension.json" with { type: "text" };
import extensionEntrypoint from "../extension/bin/fm-linear-extension" with { type: "text" };
import extensionPackage from "../extension/package.json" with { type: "text" };

export const ASSETS = {
  captainSnippet: captainSnippet as unknown as string,
  configExample: configExample as unknown as string,
  outputStyle: outputStyle as unknown as string,
  replyTemplate: replyTemplate as unknown as string,
  reportTemplate: reportTemplate as unknown as string,
  reviewTemplate: reviewTemplate as unknown as string,
  extensionManifest: extensionManifest as unknown as string,
  extensionEntrypoint: extensionEntrypoint as unknown as string,
  extensionPackage: extensionPackage as unknown as string,
} as const;
