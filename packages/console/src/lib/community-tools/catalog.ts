export type CommunityTool = {
  id: string;
  name: string;
  description: string;
  repoUrl: string;
  install?: string;
  setup?: Array<string>;
  tags: Array<string>;
};

export const COMMUNITY_TOOLS_CATALOG: Array<CommunityTool> = [
  {
    id: "pi-cocore",
    name: "pi-cocore",
    description:
      "A Pi extension that adds co/core as a model provider. Run open-source models on Apple Silicon via co/core — directly inside pi.",
    repoUrl: "https://github.com/willnewby/pi-cocore",
    install: "pi install git:github.com/willnewby/pi-cocore",
    setup: [
      "Get your API key from console.cocore.dev.",
      "Start pi — on first run you'll be prompted for the key.",
      "Or run /cocore-setup at any time to configure or change your key.",
    ],
    tags: ["pi", "Apple Silicon", "extension"],
  },
];
