import type { Request, Response } from 'express';
import { AppError } from '../../errors/index.js';
import { sendSuccess } from '../../utils/api-response.js';
import type { AuthUser } from '../users/user.types.js';
import { categoryService, type CategoryService } from './category.service.js';
import type {
  CategoryIdParam,
  CreateCategoryInput,
  UpdateCategoryInput,
} from './category.validation.js';

export class CategoryController {
  constructor(private readonly svc: CategoryService = categoryService) {}

  /**
   * GET /api/categories
   */
  listPublic = async (_req: Request, res: Response): Promise<void> => {
    const categories = await this.svc.listPublicCategories();
    sendSuccess(res, { categories });
  };

  /**
   * GET /api/admin/categories
   */
  listAdmin = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const categories = await this.svc.listAdminCategories(user);
    sendSuccess(res, { categories });
  };

  /**
   * GET /api/admin/categories/:categoryId
   */
  getAdmin = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { categoryId } = req.params as unknown as CategoryIdParam;
    const category = await this.svc.getAdminCategory({
      categoryId,
      requester: user,
    });
    sendSuccess(res, { category });
  };

  /**
   * POST /api/admin/categories
   */
  create = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const input = req.body as CreateCategoryInput;
    const category = await this.svc.createCategory({
      requester: user,
      input,
    });
    sendSuccess(res, { category }, 201);
  };

  /**
   * PATCH /api/admin/categories/:categoryId
   */
  update = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { categoryId } = req.params as unknown as CategoryIdParam;
    const input = req.body as UpdateCategoryInput;
    const category = await this.svc.updateCategory({
      categoryId,
      requester: user,
      input,
    });
    sendSuccess(res, { category });
  };

  /**
   * DELETE /api/admin/categories/:categoryId
   */
  remove = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { categoryId } = req.params as unknown as CategoryIdParam;
    await this.svc.deleteCategory({ categoryId, requester: user });
    sendSuccess(res, { message: 'Category deleted successfully' });
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    return req.user;
  }
}

export const categoryController = new CategoryController();
