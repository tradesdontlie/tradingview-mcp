import { register } from "../router.js";
import * as core from "../../core/morning.js";

register("brief", {
  description:
    "Run your morning brief — scan watchlist, read indicators, apply your rules",
  options: {
    rules: {
      type: "string",
      short: "r",
      description: "Path to rules.json (default: ./rules.json)",
    },
  },
  handler: async ({ rules }) => core.runBrief({ rules_path: rules }),
});

register("session", {
  description: "Get or save a session brief",
  subcommands: new Map([
    [
      "get",
      {
        description:
          "Get today's saved session brief (or yesterday's if today not found)",
        options: {
          date: {
            type: "string",
            description: "Date YYYY-MM-DD (default: today)",
          },
        },
        handler: async ({ date }) => core.getSession({ date }),
      },
    ],
    [
      "save",
      {
        description: "Save a session brief to disk",
        options: {
          brief: {
            type: "string",
            short: "b",
            description: "Brief text to save",
          },
          date: {
            type: "string",
            description: "Date YYYY-MM-DD (default: today)",
          },
        },
        handler: async ({ brief, date }) => {
          if (!brief) throw new Error("--brief is required");
          return core.saveSession({ brief, date });
        },
      },
    ],
  ]),
});
