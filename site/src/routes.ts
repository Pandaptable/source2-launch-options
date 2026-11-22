import { route } from "@react-router/dev/routes";

export default [
  route(":game/options", "./routes/options.tsx"),
  route(":game?", "./routes/home.tsx"),
];
