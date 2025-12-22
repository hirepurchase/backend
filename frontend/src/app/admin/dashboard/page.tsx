'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, FileText, DollarSign, AlertCircle } from 'lucide-react';
import api from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

interface DashboardStats {
  totalCustomers: number;
  activeContracts: number;
  totalRevenue: number;
  overduePayments: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    totalCustomers: 0,
    activeContracts: 0,
    totalRevenue: 0,
    overduePayments: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadDashboardStats();
  }, []);

  const loadDashboardStats = async () => {
    try {
      // In a real app, you'd have a dedicated dashboard stats endpoint
      // For now, we'll fetch from multiple endpoints
      const [customersRes, contractsRes] = await Promise.all([
        api.get('/customers?limit=1'),
        api.get('/contracts?limit=1'),
      ]);

      setStats({
        totalCustomers: customersRes.data.pagination?.total || 0,
        activeContracts: contractsRes.data.pagination?.total || 0,
        totalRevenue: 0, // Would come from a stats endpoint
        overduePayments: 0, // Would come from a stats endpoint
      });
    } catch (error) {
      console.error('Failed to load dashboard stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const statCards = [
    {
      title: 'Total Customers',
      value: stats.totalCustomers,
      icon: Users,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
    {
      title: 'Active Contracts',
      value: stats.activeContracts,
      icon: FileText,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
    },
    {
      title: 'Total Revenue',
      value: formatCurrency(stats.totalRevenue),
      icon: DollarSign,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
    },
    {
      title: 'Overdue Payments',
      value: stats.overduePayments,
      icon: AlertCircle,
      color: 'text-red-600',
      bgColor: 'bg-red-100',
    },
  ];

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">Welcome to your hire purchase management system</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {statCards.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                {stat.title}
              </CardTitle>
              <div className={`${stat.bgColor} ${stat.color} p-2 rounded-lg`}>
                <stat.icon className="h-5 w-5" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <a
              href="/admin/customers?action=new"
              className="block p-3 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
            >
              <p className="font-medium text-blue-900">Register New Customer</p>
              <p className="text-sm text-blue-700">Create a customer account and generate membership ID</p>
            </a>
            <a
              href="/admin/contracts?action=new"
              className="block p-3 bg-green-50 hover:bg-green-100 rounded-lg transition-colors"
            >
              <p className="font-medium text-green-900">Create Hire Purchase Sale</p>
              <p className="text-sm text-green-700">Initiate a new hire purchase contract</p>
            </a>
            <a
              href="/admin/products?action=new"
              className="block p-3 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors"
            >
              <p className="font-medium text-purple-900">Add Product</p>
              <p className="text-sm text-purple-700">Add new products to inventory</p>
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8 text-gray-500">
              <p>No recent activity</p>
              <p className="text-sm mt-1">Activity will appear here once you start using the system</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
