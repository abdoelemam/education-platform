import type { Request, Response } from 'express';
import { sendSuccess, sendPaginated } from '../../utils/api-response.js';
import { AppError } from '../../errors/index.js';
import type { AuthUser } from '../users/user.types.js';
import { courseService, type CourseService } from './course.service.js';
import type {
  CourseIdParam,
  CreateCourseInput,
  CreateLessonInput,
  CreateSectionInput,
  LessonParam,
  ListCoursesQuery,
  ListReviewCoursesQuery,
  RejectCourseInput,
  ReorderLessonsInput,
  ReorderSectionsInput,
  SectionParam,
  UpdateCourseInput,
  UpdateLessonInput,
  UpdateSectionInput,
} from './course.validation.js';

export class CourseController {
  constructor(private readonly svc: CourseService = courseService) {}

  /**
   * POST /api/teacher/courses
   */
  create = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const input = req.body as CreateCourseInput;

    const course = await this.svc.createCourse({ ownerId: user.id, input });
    sendSuccess(res, { course }, 201);
  };

  /**
   * GET /api/teacher/courses
   */
  list = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const query = req.query as unknown as ListCoursesQuery;

    const result = await this.svc.listCourses({
      ownerId: user.id,
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  };

  /**
   * GET /api/teacher/courses/:courseId
   */
  get = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;

    const course = await this.svc.getCourse({ courseId, requester: user });
    sendSuccess(res, { course });
  };

  /**
   * PATCH /api/teacher/courses/:courseId
   */
  update = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;
    const input = req.body as UpdateCourseInput;

    const course = await this.svc.updateCourse({ courseId, requester: user, input });
    sendSuccess(res, { course });
  };

  /**
   * DELETE /api/teacher/courses/:courseId
   */
  remove = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;

    await this.svc.deleteCourse({ courseId, requester: user });
    sendSuccess(res, { message: 'Course deleted successfully' });
  };

  /**
   * POST /api/teacher/courses/:courseId/submit
   */
  submitForReview = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;

    const course = await this.svc.submitCourse({ courseId, requester: user });
    sendSuccess(res, { course });
  };

  // ---------------------------------------------------------------------------
  // Admin moderation
  // ---------------------------------------------------------------------------

  /**
   * GET /api/admin/courses
   */
  listForReview = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const query = req.query as unknown as ListReviewCoursesQuery;

    const result = await this.svc.listCoursesForReview({
      requester: user,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  };

  /**
   * GET /api/admin/courses/:courseId
   */
  getForReview = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;

    const course = await this.svc.getCourseForReview({
      courseId,
      requester: user,
    });
    sendSuccess(res, { course });
  };

  /**
   * POST /api/admin/courses/:courseId/approve
   */
  approve = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;

    const course = await this.svc.approveCourse({ courseId, requester: user });
    sendSuccess(res, { course });
  };

  /**
   * POST /api/admin/courses/:courseId/reject
   */
  reject = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;
    const { reason } = req.body as RejectCourseInput;

    const course = await this.svc.rejectCourse({
      courseId,
      requester: user,
      reason,
    });
    sendSuccess(res, { course });
  };

  /**
   * POST /api/teacher/courses/:courseId/sections
   */
  addSection = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;
    const input = req.body as CreateSectionInput;

    const course = await this.svc.addSection({ courseId, requester: user, input });
    sendSuccess(res, { course }, 201);
  };

  /**
   * PATCH /api/teacher/courses/:courseId/sections/:sectionId
   */
  updateSection = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, sectionId } = req.params as unknown as SectionParam;
    const input = req.body as UpdateSectionInput;

    const course = await this.svc.updateSection({
      courseId,
      sectionId,
      requester: user,
      input,
    });
    sendSuccess(res, { course });
  };

  /**
   * DELETE /api/teacher/courses/:courseId/sections/:sectionId
   */
  deleteSection = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, sectionId } = req.params as unknown as SectionParam;

    const course = await this.svc.deleteSection({ courseId, sectionId, requester: user });
    sendSuccess(res, { course });
  };

  /**
   * PUT /api/teacher/courses/:courseId/sections/reorder
   */
  reorderSections = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as CourseIdParam;
    const { sectionIds } = req.body as ReorderSectionsInput;

    const course = await this.svc.reorderSections({
      courseId,
      requester: user,
      sectionIds,
    });
    sendSuccess(res, { course });
  };

  /**
   * POST /api/teacher/courses/:courseId/sections/:sectionId/lessons
   */
  addLesson = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, sectionId } = req.params as unknown as SectionParam;
    const input = req.body as CreateLessonInput;

    const course = await this.svc.addLesson({
      courseId,
      sectionId,
      requester: user,
      input,
    });
    sendSuccess(res, { course }, 201);
  };

  /**
   * PATCH /api/teacher/courses/:courseId/sections/:sectionId/lessons/:lessonId
   */
  updateLesson = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, sectionId, lessonId } = req.params as unknown as LessonParam;
    const input = req.body as UpdateLessonInput;

    const course = await this.svc.updateLesson({
      courseId,
      sectionId,
      lessonId,
      requester: user,
      input,
    });
    sendSuccess(res, { course });
  };

  /**
   * DELETE /api/teacher/courses/:courseId/sections/:sectionId/lessons/:lessonId
   */
  deleteLesson = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, sectionId, lessonId } = req.params as unknown as LessonParam;

    const course = await this.svc.deleteLesson({
      courseId,
      sectionId,
      lessonId,
      requester: user,
    });
    sendSuccess(res, { course });
  };

  /**
   * PUT /api/teacher/courses/:courseId/sections/:sectionId/lessons/reorder
   */
  reorderLessons = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, sectionId } = req.params as unknown as SectionParam;
    const { lessonIds } = req.body as ReorderLessonsInput;

    const course = await this.svc.reorderLessons({
      courseId,
      sectionId,
      requester: user,
      lessonIds,
    });
    sendSuccess(res, { course });
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    return req.user;
  }
}

export const courseController = new CourseController();
