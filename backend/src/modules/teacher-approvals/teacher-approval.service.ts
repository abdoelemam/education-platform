import { AppError } from '../../errors/index.js';
import { AUTH_ERRORS } from '../auth/auth.constants.js';
import {
  userRepository,
  type UserRepository,
} from '../users/user.repository.js';
import { toPublicUser } from '../users/user.mapper.js';
import type {
  AuthUser,
  PublicUser,
  TeacherStatus,
} from '../users/user.types.js';
import { TEACHER_APPROVAL_ERRORS } from './teacher-approval.constants.js';

export interface ListTeacherApplicationsParams {
  requester: AuthUser;
  status: TeacherStatus;
  page: number;
  limit: number;
}

export interface TeacherApplicationListResult {
  items: PublicUser[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ReviewTeacherApplicationParams {
  requester: AuthUser;
  teacherId: string;
  status: 'approved' | 'rejected';
  rejectionReason?: string;
}

/**
 * Admin-only teacher account approval workflow.
 *
 * This service deliberately operates on the existing User record. It does not
 * create a separate application entity or duplicate accounts: approval simply
 * changes the account's teacherStatus and records the review metadata.
 */
export class TeacherApprovalService {
  constructor(private readonly userRepo: UserRepository = userRepository) {}

  async listApplications(
    params: ListTeacherApplicationsParams,
  ): Promise<TeacherApplicationListResult> {
    this.assertAdmin(params.requester);

    const skip = (params.page - 1) * params.limit;
    const { items, total } = await this.userRepo.listTeachers({
      status: params.status,
      skip,
      limit: params.limit,
    });

    return {
      items: items.map(toPublicUser),
      page: params.page,
      limit: params.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / params.limit),
    };
  }

  async getApplication(
    teacherId: string,
    requester: AuthUser,
  ): Promise<PublicUser> {
    this.assertAdmin(requester);
    const teacher = await this.requireTeacher(teacherId);
    return toPublicUser(teacher);
  }

  async approveApplication(params: {
    requester: AuthUser;
    teacherId: string;
  }): Promise<PublicUser> {
    return this.reviewApplication({
      requester: params.requester,
      teacherId: params.teacherId,
      status: 'approved',
    });
  }

  async rejectApplication(params: {
    requester: AuthUser;
    teacherId: string;
    rejectionReason: string;
  }): Promise<PublicUser> {
    return this.reviewApplication({
      requester: params.requester,
      teacherId: params.teacherId,
      status: 'rejected',
      rejectionReason: params.rejectionReason,
    });
  }

  private async reviewApplication(
    params: ReviewTeacherApplicationParams,
  ): Promise<PublicUser> {
    this.assertAdmin(params.requester);

    const teacher = await this.requireTeacher(params.teacherId);
    if (teacher.teacherStatus !== 'pending') {
      throw new AppError(
        409,
        TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REVIEWABLE,
        'Only pending teacher applications can be approved or rejected',
        { currentStatus: teacher.teacherStatus },
      );
    }

    const reviewed = await this.userRepo.reviewTeacher({
      teacherId: params.teacherId,
      status: params.status,
      reviewedBy: params.requester.id,
      rejectionReason: params.rejectionReason,
    });

    if (!reviewed) {
      // Another administrator reviewed the application between our read and
      // write. The conditional update prevented a conflicting decision.
      const current = await this.userRepo.findTeacherById(params.teacherId);
      throw new AppError(
        409,
        TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REVIEWABLE,
        'The application changed while it was being reviewed. Refresh and try again.',
        { currentStatus: current?.teacherStatus ?? 'unknown' },
      );
    }

    return toPublicUser(reviewed);
  }

  /**
   * Resubmit a rejected teacher application for review.
   *
   * Only the account owner may do this, and only from `rejected`. The endpoint
   * is not a general application path: students and administrators are rejected
   * by role, pending applications are already queued, and approved accounts do
   * not need review. The transition is atomic, so two concurrent resubmissions
   * cannot both succeed.
   */
  async requestReapplication(params: {
    requester: AuthUser;
  }): Promise<PublicUser> {
    const { requester } = params;

    if (requester.role !== 'teacher') {
      throw new AppError(
        403,
        AUTH_ERRORS.FORBIDDEN,
        'Only teacher accounts can resubmit a teacher application',
      );
    }

    const teacher = await this.userRepo.findById(requester.id);
    if (!teacher) {
      throw new AppError(
        404,
        TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
        'Teacher account not found',
      );
    }

    if (teacher.teacherStatus !== 'rejected') {
      throw new AppError(
        409,
        TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REAPPLICABLE,
        'Only rejected teacher applications can be resubmitted',
        { currentStatus: teacher.teacherStatus },
      );
    }

    const reapplied = await this.userRepo.reapplyTeacher(requester.id);
    if (!reapplied) {
      const current = await this.userRepo.findTeacherById(requester.id);
      throw new AppError(
        409,
        TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REAPPLICABLE,
        'The application changed while it was being resubmitted. Refresh and try again.',
        { currentStatus: current?.teacherStatus ?? 'unknown' },
      );
    }

    return toPublicUser(reapplied);
  }

  private async requireTeacher(teacherId: string) {
    const teacher = await this.userRepo.findTeacherById(teacherId);
    if (!teacher) {
      throw new AppError(
        404,
        TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
        'Teacher account not found',
      );
    }
    return teacher;
  }

  private assertAdmin(requester: AuthUser): void {
    if (requester.role !== 'admin') {
      throw new AppError(
        403,
        AUTH_ERRORS.FORBIDDEN,
        'Administrator access required',
      );
    }
  }
}

export const teacherApprovalService = new TeacherApprovalService();
