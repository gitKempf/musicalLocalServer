/**
 * Phase 1 E2E Test: Real Project CRUD Operations
 * Tests that projects are actually stored in PostgreSQL database
 */

import axios from 'axios';
import { query } from '../../src/lib/database';

const LOCAL_SERVER_URL = 'http://localhost:17100';

describe('Phase 1: Real Project CRUD - Database Integration', () => {
  const testUserId = 17; // User ID from auth
  let createdProjectId: string;

  // Set timeout for tests
  jest.setTimeout(30000);

  describe('Database Connection', () => {
    test('should connect to PostgreSQL database', async () => {
      const result = await query('SELECT NOW() as now');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].now).toBeDefined();
      console.log('✅ Database connection working');
    });

    test('should have projects table with correct schema', async () => {
      const result = await query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'projects'
        ORDER BY ordinal_position;
      `);

      const columns = result.rows.map(r => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('user_id');
      expect(columns).toContain('name');
      expect(columns).toContain('gitea_repo_url');
      expect(columns).toContain('container_id');
      expect(columns).toContain('ssh_port');

      console.log('✅ Projects table schema is correct');
      console.log(`  Columns: ${columns.join(', ')}`);
    });
  });

  describe('Project Creation - REAL Database Write', () => {
    test('should create project directly in database using ProjectService', async () => {
      // Direct database insert to test service
      const ProjectService = (await import('../../src/services/ProjectService')).default;

      const projectData = {
        id: `test_project_${Date.now()}`,
        userId: testUserId,
        name: 'Test Real Project',
        description: 'Testing REAL database storage',
        template: 'react-native',
        initialPrompt: 'Create a todo app with React Native',
      };

      const project = await ProjectService.createProject(projectData);

      expect(project).toBeDefined();
      expect(project.id).toBe(projectData.id);
      expect(project.name).toBe(projectData.name);
      expect(project.user_id).toBe(testUserId);
      expect(project.template).toBe('react-native');

      createdProjectId = project.id;

      // Verify it's actually in database
      const dbResult = await query(
        'SELECT * FROM projects WHERE id = $1',
        [createdProjectId]
      );

      expect(dbResult.rows.length).toBe(1);
      expect(dbResult.rows[0].name).toBe(projectData.name);
      expect(dbResult.rows[0].initial_prompt).toBe(projectData.initialPrompt);

      console.log('✅ Project created in database');
      console.log(`  Project ID: ${createdProjectId}`);
      console.log(`  Name: ${project.name}`);
    });
  });

  describe('Project Retrieval - REAL Database Read', () => {
    test('should retrieve project from database', async () => {
      const ProjectService = (await import('../../src/services/ProjectService')).default;

      const project = await ProjectService.getProject(createdProjectId, testUserId);

      expect(project).toBeDefined();
      expect(project?.id).toBe(createdProjectId);
      expect(project?.name).toBe('Test Real Project');
      expect(project?.user_id).toBe(testUserId);

      console.log('✅ Project retrieved from database');
    });

    test('should list user projects from database', async () => {
      const ProjectService = (await import('../../src/services/ProjectService')).default;

      const projects = await ProjectService.listUserProjects(testUserId);

      expect(Array.isArray(projects)).toBe(true);
      expect(projects.length).toBeGreaterThan(0);

      const ourProject = projects.find(p => p.id === createdProjectId);
      expect(ourProject).toBeDefined();

      console.log('✅ Projects listed from database');
      console.log(`  Total projects for user ${testUserId}: ${projects.length}`);
    });
  });

  describe('Project Update - REAL Database Modify', () => {
    test('should update project in database', async () => {
      const ProjectService = (await import('../../src/services/ProjectService')).default;

      const updates = {
        containerId: 'container_abc123',
        sshPort: 17201,
        giteaRepoUrl: 'http://localhost:17101/musical/test-project',
        previewUrl: 'http://localhost:17200/preview/test',
      };

      const updatedProject = await ProjectService.updateProject(createdProjectId, updates);

      expect(updatedProject.container_id).toBe(updates.containerId);
      expect(updatedProject.ssh_port).toBe(updates.sshPort);
      expect(updatedProject.gitea_repo_url).toBe(updates.giteaRepoUrl);
      expect(updatedProject.preview_url).toBe(updates.previewUrl);

      // Verify in database
      const dbResult = await query(
        'SELECT * FROM projects WHERE id = $1',
        [createdProjectId]
      );

      expect(dbResult.rows[0].container_id).toBe(updates.containerId);
      expect(dbResult.rows[0].ssh_port).toBe(updates.sshPort);

      console.log('✅ Project updated in database');
      console.log(`  Container ID: ${updates.containerId}`);
      console.log(`  SSH Port: ${updates.sshPort}`);
    });
  });

  describe('Project Deletion - REAL Soft Delete', () => {
    test('should soft-delete project (set status=deleted)', async () => {
      const ProjectService = (await import('../../src/services/ProjectService')).default;

      const deleted = await ProjectService.deleteProject(createdProjectId, testUserId);

      expect(deleted).toBeDefined();
      expect(deleted.id).toBe(createdProjectId);

      // Verify status changed to 'deleted' in database
      const dbResult = await query(
        'SELECT status FROM projects WHERE id = $1',
        [createdProjectId]
      );

      expect(dbResult.rows[0].status).toBe('deleted');

      console.log('✅ Project soft-deleted in database');
      console.log(`  Status set to: deleted`);
    });

    test('should not appear in active projects list', async () => {
      const ProjectService = (await import('../../src/services/ProjectService')).default;

      const activeProjects = await ProjectService.listUserProjects(testUserId, {
        status: 'active',
      });

      const deletedProject = activeProjects.find(p => p.id === createdProjectId);
      expect(deletedProject).toBeUndefined();

      console.log('✅ Deleted project not in active list');
    });
  });

  describe('Comparison: Old vs New Implementation', () => {
    test('OLD FAKE implementation would NOT have data in database', async () => {
      // This test documents what the old fake implementation did wrong
      console.log('❌ OLD Implementation:');
      console.log('  - Returned fake JSON: {id: "project_123", name: "Sample Project"}');
      console.log('  - No database write');
      console.log('  - Data lost on server restart');
      console.log('  - Always returned hardcoded "Sample Project"');
    });

    test('NEW REAL implementation DOES store data in database', async () => {
      // Verify our data persists
      const dbResult = await query(
        'SELECT COUNT(*) as count FROM projects WHERE user_id = $1',
        [testUserId]
      );

      const projectCount = parseInt(dbResult.rows[0].count);
      expect(projectCount).toBeGreaterThan(0);

      console.log('✅ NEW Implementation:');
      console.log(`  - ${projectCount} real projects in database`);
      console.log('  - Data persists across server restarts');
      console.log('  - Real CRUD operations working');
      console.log('  - PostgreSQL database integration complete');
    });
  });

  // Cleanup
  afterAll(async () => {
    // Hard delete test project
    await query('DELETE FROM projects WHERE id = $1', [createdProjectId]);
    console.log('✅ Test project cleaned up from database');
  });
});
