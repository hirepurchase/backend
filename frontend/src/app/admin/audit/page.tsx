'use client';

import { useEffect, useState } from 'react';
import { FileText, Filter, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import api from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

export default function AuditTrailPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [entities, setEntities] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [filters, setFilters] = useState({
    action: '',
    entity: '',
    userId: '',
    startDate: '',
    endDate: '',
  });
  const itemsPerPage = 50;
  const { toast } = useToast();

  useEffect(() => {
    loadAuditLogs();
    loadStats();
    loadFilterOptions();
  }, [currentPage, filters]);

  const loadAuditLogs = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/audit', {
        params: {
          page: currentPage,
          limit: itemsPerPage,
          action: filters.action || undefined,
          entity: filters.entity || undefined,
          userId: filters.userId || undefined,
          startDate: filters.startDate || undefined,
          endDate: filters.endDate || undefined,
        },
      });
      setLogs(response.data.logs || []);
      setTotalPages(response.data.pagination?.totalPages || 1);
      setTotalItems(response.data.pagination?.total || 0);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load audit logs',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await api.get('/audit/stats', {
        params: {
          startDate: filters.startDate || undefined,
          endDate: filters.endDate || undefined,
        },
      });
      setStats(response.data);
    } catch (error: any) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadFilterOptions = async () => {
    try {
      const [actionsRes, entitiesRes] = await Promise.all([
        api.get('/audit/actions'),
        api.get('/audit/entities'),
      ]);
      setActions(actionsRes.data || []);
      setEntities(entitiesRes.data || []);
    } catch (error: any) {
      console.error('Failed to load filter options:', error);
    }
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handleFilterChange = (key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setCurrentPage(1);
  };

  const clearFilters = () => {
    setFilters({
      action: '',
      entity: '',
      userId: '',
      startDate: '',
      endDate: '',
    });
    setCurrentPage(1);
  };

  const getActionColor = (action: string) => {
    if (action.startsWith('CREATE')) return 'bg-green-100 text-green-800';
    if (action.startsWith('UPDATE')) return 'bg-blue-100 text-blue-800';
    if (action.startsWith('DELETE')) return 'bg-red-100 text-red-800';
    if (action.startsWith('LOGIN') || action.startsWith('LOGOUT')) return 'bg-purple-100 text-purple-800';
    return 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Audit Trail</h1>
          <p className="text-gray-600 mt-1">System activity and change history</p>
        </div>
      </div>

      {/* Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Total Logs</p>
                  <p className="text-2xl font-bold mt-1">{stats.totalLogs?.toLocaleString()}</p>
                </div>
                <FileText className="h-8 w-8 text-blue-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Unique Actions</p>
                  <p className="text-2xl font-bold mt-1">{stats.actionCounts?.length || 0}</p>
                </div>
                <Filter className="h-8 w-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Entities Tracked</p>
                  <p className="text-2xl font-bold mt-1">{stats.entityCounts?.length || 0}</p>
                </div>
                <FileText className="h-8 w-8 text-purple-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Active Users</p>
                  <p className="text-2xl font-bold mt-1">{stats.userActivity?.length || 0}</p>
                </div>
                <FileText className="h-8 w-8 text-orange-600" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Action</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.action}
                onChange={(e) => handleFilterChange('action', e.target.value)}
              >
                <option value="">All Actions</option>
                {actions.map((action) => (
                  <option key={action} value={action}>{action}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Entity</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.entity}
                onChange={(e) => handleFilterChange('entity', e.target.value)}
              >
                <option value="">All Entities</option>
                {entities.map((entity) => (
                  <option key={entity} value={entity}>{entity}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Start Date</label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => handleFilterChange('startDate', e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">End Date</label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => handleFilterChange('endDate', e.target.value)}
              />
            </div>

            <div className="flex items-end">
              <Button variant="outline" onClick={clearFilters} className="w-full">
                Clear Filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Audit Logs Table */}
      <Card>
        <CardHeader>
          <CardTitle>Activity Log</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <FileText className="h-16 w-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">No audit logs found</p>
              <p className="text-sm mt-1">Activity logs will appear here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Entity ID</TableHead>
                    <TableHead>IP Address</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm">
                        {formatDate(log.createdAt)}
                      </TableCell>
                      <TableCell>
                        {log.user ? (
                          <div>
                            <p className="font-medium text-sm">
                              {log.user.firstName} {log.user.lastName}
                            </p>
                            <p className="text-xs text-gray-500">{log.user.email}</p>
                          </div>
                        ) : (
                          <span className="text-gray-400">System</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={getActionColor(log.action)}>
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{log.entity}</TableCell>
                      <TableCell className="font-mono text-xs text-gray-600">
                        {log.entityId ? log.entityId.substring(0, 8) + '...' : '-'}
                      </TableCell>
                      <TableCell className="text-sm text-gray-600">
                        {log.ipAddress || '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
        {!isLoading && logs.length > 0 && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            totalItems={totalItems}
            itemsPerPage={itemsPerPage}
          />
        )}
      </Card>
    </div>
  );
}
