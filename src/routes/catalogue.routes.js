import { Router } from "express";
import { createCrudRoutes } from "../utils/crud.js";
import { Catalogue } from "../models/index.js";
const router = Router();
createCrudRoutes(router, Catalogue, "catalogue", "sku", void 0, "CATALOGUE", { softDelete: true });
var stdin_default = router;
export {
  stdin_default as default
};
